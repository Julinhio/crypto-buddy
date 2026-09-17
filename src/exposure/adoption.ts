/**
 * C8 — DOES THE MODEL USE THE EXPOSURE THE BAND IMPOSED, OR FIGHT IT? Read per EPISODE.
 *
 * PURE and TOTAL: no I/O, no clock. Everything arrives as an argument — the corrections
 * journal's lines, the decisions' statuses and proposals, the gate verdicts — and every reading
 * is a function of them, so a test can walk an episode in five lines.
 *
 * ── THE UNIT OF MEASURE IS THE EXECUTED EPISODE, PER ASSET ────────────────────────────
 *
 * Not "every planned line", not "every cycle on which the correction is still visible". An
 * episode is one leg the band REALLY EXECUTED on one asset at one cycle: origin
 * `correction_de_bande` or `allocation_de_secours`, a booked side, the correction allowed to
 * act that cycle, and `correction_moves_holding` TRUE — the band's correction really changed
 * the executable holding, rather than moving a target the uncorrected plan would have booked
 * identically (fourth review round). A planned leg the executor dropped never changed what the
 * model sees, and a cycle where the correction merely stays visible is the same episode still
 * — counting it again would count the model's one reaction as many.
 *
 * ── WHAT A REACTION IS, AND WHAT IS NOT ONE ───────────────────────────────────────────
 *
 * The reaction is the model's OWN proposal on the first DECIDED cycle after the episode. A
 * cycle that failed in between — `error`, `guard_failed`, `parse_failed`, `skipped` — produced
 * no proposal and moved no order; it is not a reaction and it is not counted as one, it is
 * named as skipped. And the reaction is read against the model's own words at the episode,
 * `raw_weight_percent`, never against the clamped or the corrected figure: what it repeats or
 * abandons is what IT asked for.
 *
 * ── THE FOUR READINGS, AND WHY "ADOPTION" IS NOT ONE OF THEM ─────────────────────────
 *
 * Direction matters. An upward episode (the band bought) and a downward one (the band sold)
 * are read with the inequalities reversed, which the first reader did not do: it called
 * "adoption" any next weight at or above the imposed one, so on a downward episode a model
 * that simply REPEATED its own higher target was read as adopting the band.
 *
 *   repetition     the model re-emits its initial target, exactly — checked FIRST, whatever
 *                  the direction. A repeated initial target is never called adoption. A first
 *                  proposal of zero that stays at zero is a repetition, not a fight: there is
 *                  no "further" than zero to go.
 *   maintien       the next proposal sits at the imposed weight, or beyond it in the band's
 *                  direction. The model KEEPS the position the band built.
 *   rapprochement  strictly between its own initial target and the imposed weight.
 *   lutte          beyond its own initial target, AGAINST the band's direction.
 *
 * ── WHAT NONE OF THIS PROVES ──────────────────────────────────────────────────────────
 *
 * The prompt shows the model the corrected allocation under the label `risk_clamp`, frozen for
 * the whole pilot: the model is told the risk wrapper trimmed its proposal, when the band raised
 * or lowered it. A `maintien` therefore describes the model's reaction to a corrected
 * PORTFOLIO — it does not prove a conscious adoption of the exposure band. The readings are
 * descriptive, and they stay descriptive until the measurement window is officially closed:
 * no verdict is published on an open window.
 */

export type LineOrigin = 'modele' | 'correction_de_bande' | 'allocation_de_secours';

/** One row of `exposure_band_corrections`, as the journal holds it. */
export interface JournalCorrectionLine {
  decisionId: number;
  asset: string;
  origin: LineOrigin;
  cause: string;
  rawWeightPercent: number | null;
  clampedWeightPercent: number;
  baseWeightPercent: number;
  correctionPoints: number;
  correctedWeightPercent: number;
  plannedSide: 'buy' | 'sell' | null;
  plannedNotionalQuote: number | null;
  /** Set when the corrector's own floor deleted the leg — then `plannedSide` is null. */
  suppressedReason: string | null;
  suppressedNotionalQuote: number | null;
  bookedSide: 'buy' | 'sell' | null;
  bookedNotionalQuote: number | null;
  postCycleWeightPercent: number | null;
  /**
   * Did the correction CHANGE THE EXECUTABLE HOLDING on that line? The journal stores it for
   * the case where the correction moves the target but the corrected and uncorrected plans
   * book the same holding — a booking there is the model's plan, not the band's. Null when the
   * column could not be read; in the official window that is a refusal, never an exclusion.
   */
  correctionMovesHolding: boolean | null;
}

/** What the reader needs of a decision: its status, and the model's own proposal. */
export interface DecisionSummary {
  id: number;
  status: string;
  targetAllocation: Record<string, number> | null;
}

export type EpisodeDirection = 'hausse' | 'baisse';

export type EpisodeReading =
  | 'repetition'
  | 'maintien'
  | 'rapprochement'
  | 'lutte'
  /** A later event on that line makes the reaction unattributable to this episode. */
  | 'non_attribuable'
  /** No decided cycle followed inside the window, or the model's own weight is unknown. */
  | 'non_mesurable';

export interface AdoptionEpisode {
  decisionId: number;
  asset: string;
  origin: LineOrigin;
  direction: EpisodeDirection;
  /** The model's OWN words at the episode — `raw_weight_percent`. Null when the journal has none. */
  modelWeightPercent: number | null;
  clampedWeightPercent: number;
  /** What the band imposed — `corrected_weight_percent`. */
  imposedWeightPercent: number;
  /** What the model then actually saw — `post_cycle_weight_percent`. */
  realisedWeightPercent: number | null;
  bookedSide: 'buy' | 'sell';
  bookedNotionalQuote: number | null;
  /** The first DECIDED cycle after the episode, and the model's proposal on that line there. */
  reaction: { decisionId: number; modelWeightPercent: number | null } | null;
  /** Failed cycles between the episode and its reaction — named, and NOT reactions. */
  skippedCycles: Array<{ id: number; status: string }>;
  reading: EpisodeReading;
  /** Why the reading is `non_attribuable` or `non_mesurable`. Null otherwise. */
  because: string | null;
}

const TOL = 1e-6;

/**
 * THE READER — one episode, one reading. Direction-aware, repetition first.
 */
export function readEpisodeReaction(input: {
  direction: EpisodeDirection;
  modelWeightPercent: number | null;
  imposedWeightPercent: number;
  nextModelWeightPercent: number | null;
}): Exclude<EpisodeReading, 'non_attribuable'> {
  const { direction, modelWeightPercent: own, imposedWeightPercent: imposed, nextModelWeightPercent: next } = input;
  if (own == null || next == null || !Number.isFinite(own) || !Number.isFinite(next)) return 'non_mesurable';
  // THE REPEATED INITIAL TARGET, first and whatever the direction: never adoption.
  if (Math.abs(next - own) <= TOL) return 'repetition';
  if (direction === 'hausse') {
    if (next >= imposed - TOL) return 'maintien';
    if (next > own) return 'rapprochement';
    return 'lutte';
  }
  if (next <= imposed + TOL) return 'maintien';
  if (next < own) return 'rapprochement';
  return 'lutte';
}

export interface BuildEpisodesInput {
  /** The corrections journal, every line of every cycle in scope. */
  lines: readonly JournalCorrectionLine[];
  /** Every decision in scope, in id order, whatever its status — failed ones are named. */
  decisions: readonly DecisionSummary[];
  /** Episodes are only counted inside this window (inclusive). */
  fromDecisionId: number;
  toDecisionId: number;
  /**
   * Gate verdicts per cycle per asset. A `stop_exit` or `risk_off_reduction` on the episode's
   * line AT THE REACTION CYCLE is the code taking that line over: under `enforce` the model is
   * told so in its prompt, and its proposal on that line is no longer a free reaction to the
   * episode. Only the reaction cycle's own verdict counts — a failed cycle in between also
   * journals a verdict, but it placed no order and consulted no model: an observation, not an
   * intervention (first review round).
   */
  gateOf: (decisionId: number, asset: string) => string | null;
  /**
   * THE GATE'S MODE, frozen in the pilot's identity. Only under `enforce` does a verdict act:
   * under `observe` `applyGate` is a no-op, the model is told nothing, and its proposal stays
   * a free reaction. Null on the bench, where no band leg was ever executed anyway.
   */
  transitionMode: 'observe' | 'enforce' | null;
  /**
   * Was the correction ALLOWED TO ACT on that cycle — mode `application` and no `pilot_hold`?
   * The journal computes and records the correction on every cycle, held or not, and
   * `booked_side` records what the bot REALLY booked on the asset. On a held cycle a booking
   * on a band-origin line is the uncorrected model's own trade: not an episode (third review
   * round).
   */
  correctionAllowed: (decisionId: number) => boolean;
}

export interface BuiltEpisodes {
  episodes: AdoptionEpisode[];
  /**
   * Band lines that would have been episodes but whose `correction_moves_holding` could not be
   * read. Never excluded in silence: the caller refuses an official result on them.
   */
  unreadable: Array<{ decisionId: number; asset: string }>;
}

/**
 * THE EPISODES, built from the journal — executed band legs only, each with its reaction.
 */
export function buildEpisodes(input: BuildEpisodesInput): BuiltEpisodes {
  const decisions = [...input.decisions].sort((a, b) => a.id - b.id);
  const unreadable: Array<{ decisionId: number; asset: string }> = [];

  const episodes: AdoptionEpisode[] = [];
  for (const line of input.lines) {
    if (line.origin === 'modele' || line.bookedSide == null) continue;
    if (line.decisionId < input.fromDecisionId || line.decisionId > input.toDecisionId) continue;
    if (line.correctionPoints === 0) continue;
    if (!input.correctionAllowed(line.decisionId)) continue;
    // THE HOLDING MUST HAVE MOVED BECAUSE OF THE BAND. False: the booking was the model's own
    // plan, no episode. Null: unreadable — reported, never dropped in silence.
    if (line.correctionMovesHolding == null) {
      unreadable.push({ decisionId: line.decisionId, asset: line.asset });
      continue;
    }
    if (line.correctionMovesHolding === false) continue;
    const direction: EpisodeDirection = line.correctionPoints > 0 ? 'hausse' : 'baisse';

    // The reaction: the first DECIDED cycle after the episode, inside the window. Everything
    // non-decided in between is named and not read.
    const later = decisions.filter((d) => d.id > line.decisionId && d.id <= input.toDecisionId);
    const skipped: Array<{ id: number; status: string }> = [];
    let reactionDecision: DecisionSummary | null = null;
    for (const d of later) {
      if (d.status === 'decided') {
        reactionDecision = d;
        break;
      }
      skipped.push({ id: d.id, status: d.status });
    }

    let reading: EpisodeReading;
    let because: string | null = null;
    let reaction: AdoptionEpisode['reaction'] = null;
    if (reactionDecision == null) {
      reading = 'non_mesurable';
      because = 'aucun cycle décidé ne suit l’épisode dans la fenêtre';
    } else {
      const nextWeight = reactionDecision.targetAllocation?.[line.asset] ?? null;
      reaction = { decisionId: reactionDecision.id, modelWeightPercent: nextWeight };
      // THE EVENT THAT BREAKS THE ATTRIBUTION: the code's own stop or a risk-off reduction
      // taking the line over AT the reaction cycle. Nothing else can: the cycles in between are
      // the failed ones — no order, no model, their gate rows are observations — and another
      // band leg cannot fall there either, since a failed cycle computes no correction.
      const reactionGate = input.transitionMode === 'enforce' ? input.gateOf(reactionDecision.id, line.asset) : null;
      const intervening =
        reactionGate === 'stop_exit' || reactionGate === 'risk_off_reduction'
          ? { id: reactionDecision.id, gate: reactionGate }
          : null;
      if (intervening != null) {
        reading = 'non_attribuable';
        because = `la porte a pris la ligne ${line.asset} (${intervening.gate}) au cycle ${intervening.id}`;
      } else {
        reading = readEpisodeReaction({
          direction,
          modelWeightPercent: line.rawWeightPercent,
          imposedWeightPercent: line.correctedWeightPercent,
          nextModelWeightPercent: nextWeight,
        });
        if (reading === 'non_mesurable') {
          because =
            line.rawWeightPercent == null
              ? 'le journal ne porte pas la proposition brute du modèle sur cette ligne'
              : 'le cycle de réaction ne porte pas de proposition sur cette ligne';
        }
      }
    }

    episodes.push({
      decisionId: line.decisionId,
      asset: line.asset,
      origin: line.origin,
      direction,
      modelWeightPercent: line.rawWeightPercent,
      clampedWeightPercent: line.clampedWeightPercent,
      imposedWeightPercent: line.correctedWeightPercent,
      realisedWeightPercent: line.postCycleWeightPercent,
      bookedSide: line.bookedSide,
      bookedNotionalQuote: line.bookedNotionalQuote,
      reaction,
      skippedCycles: skipped,
      reading,
      because,
    });
  }
  return {
    episodes: episodes.sort((a, b) => a.decisionId - b.decisionId || (a.asset < b.asset ? -1 : 1)),
    unreadable,
  };
}

// ── THE JUDGE — W6 ────────────────────────────────────────────────────────────────────

export type CriterionStatus = 'pass' | 'fail' | 'non_mesurable';

export interface C8Judgement {
  status: CriterionStatus;
  /** Never true while the window is open: the readings are descriptive until the closure. */
  official: boolean;
  population: number;
  readable: number;
  byReading: Record<EpisodeReading, number>;
  problems: string[];
}

/**
 * W6 — C8 is exercised on the real eligible episodes, and no verdict is official before the
 * closure.
 *
 * It can FAIL: an episode whose reaction is not the first decided cycle after it, an episode
 * with no booked side, an episode outside the window, a reading that does not match its own
 * numbers, or an official flag while the window is open. It is NON MESURABLE, never green,
 * when the window holds no executed episode — or none whose reaction could be read: a
 * population of unreadable episodes measures nothing and publishes nothing official.
 */
export function judgeC8(input: {
  episodes: readonly AdoptionEpisode[];
  decisions: readonly DecisionSummary[];
  fromDecisionId: number;
  toDecisionId: number;
  windowClosed: boolean;
  /** What the report is about to publish. The judge refuses an official claim on an open window. */
  claimsOfficial: boolean;
  /** Band lines whose `correction_moves_holding` could not be read — see `BuiltEpisodes`. */
  unreadable?: ReadonlyArray<{ decisionId: number; asset: string }>;
  /** In an official window an unreadable line is a REFUSAL of the whole reading. */
  official?: boolean;
}): C8Judgement {
  const problems: string[] = [];
  if (input.official && (input.unreadable?.length ?? 0) > 0) {
    problems.push(
      `REFUS : correction_moves_holding illisible en fenêtre officielle sur ${input.unreadable!.length} ligne(s) — ` +
        input.unreadable!.map((u) => `#${u.decisionId} ${u.asset}`).join(', ') +
        ' ; aucune lecture C8 ne peut être publiée sur ce journal',
    );
  }
  const byReading: Record<EpisodeReading, number> = {
    repetition: 0,
    maintien: 0,
    rapprochement: 0,
    lutte: 0,
    non_attribuable: 0,
    non_mesurable: 0,
  };
  const decided = [...input.decisions].filter((d) => d.status === 'decided').sort((a, b) => a.id - b.id);

  for (const episode of input.episodes) {
    byReading[episode.reading] += 1;
    if (episode.decisionId < input.fromDecisionId || episode.decisionId > input.toDecisionId) {
      problems.push(`épisode ${episode.decisionId} ${episode.asset} hors de la fenêtre`);
    }
    if (episode.bookedSide == null) {
      problems.push(`épisode ${episode.decisionId} ${episode.asset} sans jambe exécutée`);
    }
    const firstDecidedAfter = decided.find((d) => d.id > episode.decisionId && d.id <= input.toDecisionId) ?? null;
    if (episode.reaction != null && (firstDecidedAfter == null || episode.reaction.decisionId !== firstDecidedAfter.id)) {
      problems.push(
        `épisode ${episode.decisionId} ${episode.asset} : la réaction est lue au cycle ${episode.reaction.decisionId}, ` +
          `le premier cycle décidé suivant est ${firstDecidedAfter?.id ?? 'absent'}`,
      );
    }
    if (episode.reaction == null && episode.reading !== 'non_mesurable') {
      problems.push(`épisode ${episode.decisionId} ${episode.asset} : lecture ${episode.reading} sans cycle de réaction`);
    }
    if (episode.reaction != null && episode.reading !== 'non_attribuable') {
      const recomputed = readEpisodeReaction({
        direction: episode.direction,
        modelWeightPercent: episode.modelWeightPercent,
        imposedWeightPercent: episode.imposedWeightPercent,
        nextModelWeightPercent: episode.reaction.modelWeightPercent,
      });
      if (recomputed !== episode.reading) {
        problems.push(
          `épisode ${episode.decisionId} ${episode.asset} : lecture ${episode.reading} ne correspond pas à ses nombres (${recomputed})`,
        );
      }
    }
  }
  if (input.claimsOfficial && !input.windowClosed) {
    problems.push('un verdict officiel est publié alors que la fenêtre de mesure est ouverte');
  }

  const readable = input.episodes.filter((e) => e.reading !== 'non_mesurable' && e.reading !== 'non_attribuable').length;
  const status: CriterionStatus = problems.length > 0 ? 'fail' : readable === 0 ? 'non_mesurable' : 'pass';
  return {
    status,
    official: input.windowClosed && problems.length === 0 && readable > 0,
    population: input.episodes.length,
    readable,
    byReading,
    problems,
  };
}
