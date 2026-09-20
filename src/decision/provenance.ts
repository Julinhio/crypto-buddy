/**
 * THE PROVENANCE OF A CYCLE'S MOVEMENTS — who really moved each line.
 *
 * The activity notification used to print the booked movements under the model's own
 * `notification_summary`, as if every order were the model's. It is not. Since the exposure
 * pilot was armed, the band lifts and trims lines the model never asked to move (2112: three
 * buys under "aucune action ce cycle"); since the gate was armed, the code exits a line on a
 * peak stop (2051: a $142 XRP sale under "maintien de toutes les positions"); and a cycle can
 * be all of these at once (2139: the model trimmed ETH, the band bought BTC and XRP). The
 * orders were right every time. The explanation was wrong every time.
 *
 * ── THE FRONTIER, arbitrated on 20/09/2026 ────────────────────────────────────────────
 *
 * A movement is THE MODEL'S when its intention on that line CHANGED this cycle — the same
 * frontier the coherence guard uses since PR #48, the same epsilon — AND the model's own plan
 * (its clamped target against the book, before the band and the gate) trades the line in the
 * same direction. Neither `action_type` nor the reasoning text can attribute a movement: the
 * first is declarative, the second is prose, and both said "hold" on 2112 and 2051.
 *
 * Everything else is the chain's, and each layer is named by the fact that proves it:
 *
 *   - a STOP: the asset is among the code's synthesized exits. Protective exits are the
 *     operational cause before anything else, and when they replace a standing intention
 *     the message says so rather than presenting the order as the model's free choice;
 *   - the BAND: this cycle's correction changed the line's weight (`correctionPoints ≠ 0`);
 *   - the band MOVING its correction: the line is unchanged in intention and untouched by
 *     this cycle's correction, but the chain's last applied target sat ABOVE the model's
 *     last intention on it, and this cycle the band no longer holds it there, so the line
 *     returns to the model's target. Two writers leave an applied target above the
 *     intention: the band, and a GATE REFUSAL that kept the previous vector while the
 *     intention went down — told apart by the row's `applied_divergence_cause`, which only
 *     a refusal sets (the clamp only lowers a line, a stop flattens both columns). With no
 *     divergence cause on the reference row the lift is the band's; WITH one, nothing here
 *     can say which lines the refusal itself displaced and which the kept vector already
 *     carried from an earlier correction, so no line of that row is claimed for the band —
 *     it is "the chain", with the refusal named as the fact on record. That is 2141 XRP:
 *     `origin = modele` in the journal, `correction_points = 0`, and yet not a decision of
 *     the model's, which had not changed its mind about XRP since 2139;
 *   - the band AGAINST the model: the model changed its intention on the line and the
 *     correction moved it the other way (or beyond a change too small to trade);
 *   - a RETURN to the target: the chain had left the line away from the intention — below
 *     it (the risk clamp or a downward correction, not separable from the references alone,
 *     so the layer is named as "the chain"), or above it because the transition gate refused
 *     the revision that lowered it (named as the gate) — and the line comes back toward it;
 *   - DRIFT: the line's applied target WAS the intention, nothing changed, and the book
 *     moved by prices past the floor. The standing target reasserts itself. Not a decision.
 *     A correction that moved the line the OTHER way than the movement (the band lifting a
 *     target the book had drifted above, softening the sale) only RESIZED that drift — or
 *     that return toward the target — and is named as the layer that adjusted the amount,
 *     never as the cause. The band is the cause only when its points and the trade point
 *     the same way, or when it is MOVING ITS OWN CORRECTION: the corrected target comes
 *     STRICTLY CLOSER to the unchanged intention than the previous applied target, on the
 *     same side of it — whether the line sat above or below the intention. A corrected
 *     target at the same distance, farther away, or across the intention is not the band
 *     unwinding anything, and the movement keeps its drift or return origin;
 *   - NOT ESTABLISHED: anything the facts above cannot explain. Said explicitly, never
 *     replaced by the most plausible layer.
 *
 * WITHOUT AN INTENTION REFERENCE (the first decision ever, or a restatement that failed)
 * the guard's permissive posture — everything is the model's — is deliberately NOT taken
 * over here. A notification says only what the chain can prove: deterministic interventions
 * are attributed, a movement the model's own plan produces in the same direction with no
 * layer over it is the model's, and the rest is not established.
 *
 * PURE. The facts are gathered by `decide()` from values it already holds on the decided
 * path (no new read, nothing persisted, no order changed) and the derivation runs on them —
 * which is also what lets a replay rebuild the same facts from the journals and print the
 * exact message a cycle would have sent.
 */
import type { BandCorrectionLabel, BandDirection } from '../exposure/band.js';
import type { LineCause, LineOrigin } from '../exposure/correct.js';

/** The guard's own notion of "the same weight" — one epsilon for every comparison here. */
export const PROVENANCE_EPSILON = 0.01;

export interface ProvenanceLeg {
  asset: string;
  side: 'buy' | 'sell';
  /** In quote currency, as the plan sized it. */
  notional: number;
}

export interface BandLineFact {
  asset: string;
  /** Signed points the correction added to or removed from this line, this cycle. */
  correctionPoints: number;
  origin: LineOrigin;
  /** Why the line did not absorb what the band asked — `aucune` when nothing stopped it. */
  cause: LineCause;
  baseWeightPercent: number;
  correctedWeightPercent: number;
}

export interface BandFact {
  direction: BandDirection;
  label: BandCorrectionLabel;
  /** The bound the correction moved the target to. Null when no correction was due. */
  boundPercent: number | null;
  /** The exposure of the target the band assessed — the clamped proposal's. */
  targetExposurePercent: number;
  correctedExposurePercent: number;
  unrealisablePoints: number;
  consolidated: boolean;
  lines: BandLineFact[];
}

export interface StopExitFact {
  asset: string;
  notional: number;
  drawdownFromPeakPercent: number | null;
  thresholdPercent: number;
}

export interface GateFact {
  refused: boolean;
  reason: string;
  droppedLegs: ProvenanceLeg[];
}

/** The facts of one decided cycle, gathered where they are already in hand. */
export interface CycleProvenance {
  /** The cash side. Never a movement, never a revision — excluded from every comparison. */
  reserveAsset: string;
  /** The model's raw target — what it emitted. */
  target: Record<string, number>;
  /** The same target after the risk clamp. Equal to `target` unless a cap bit. */
  clamped: Record<string, number>;
  clampReason: string | null;
  /** The last recorded intention, restated in this cycle's universe. Null: no reference. */
  intentReference: Record<string, number> | null;
  /** The last effective target the chain retained, restated the same way. Null: none. */
  appliedReference: Record<string, number> | null;
  /**
   * Why the reference row's applied target differs from its intention when the TRANSITION
   * GATE caused it (`applied_divergence_cause`); null when it did not refuse that cycle.
   * The one fact that separates "the band lifted this line" from "a refusal kept the old
   * vector while the model lowered its intention".
   */
  appliedReferenceDivergence: string | null;
  /** The model's OWN plan: the clamped target against the book, before band and gate. */
  modelLegs: ProvenanceLeg[];
  /** This cycle's band correction, when the pilot corrected. Null otherwise. */
  band: BandFact | null;
  /** The peak stop's exits, generated by the code. */
  stopExits: StopExitFact[];
  gate: GateFact;
}

export type MovementOrigin =
  | 'modele'
  | 'stop'
  | 'bande'
  | 'bande_deplacement'
  | 'bande_contre_modele'
  | 'retour_vers_cible'
  | 'derive'
  | 'non_etablie';

/** A layer that changed the SIZE of a movement the model decided. */
export type AmountAdjustment =
  | {
      layer: 'bande';
      /** Signed points the band added to the line. */
      points: number;
      /** What the model's own plan would have traded on this line, in quote. */
      modelPlanNotional: number;
    }
  | { layer: 'plafond_de_risque'; fromPercent: number; toPercent: number };

export interface AttributedMovement {
  asset: string;
  side: 'buy' | 'sell';
  /** Dollars actually booked (|quoteDelta|). */
  usd: number;
  origin: MovementOrigin;
  /** The model's intention on the line, before → after, when it changed. */
  intentChange: { fromPercent: number | null; toPercent: number } | null;
  adjustments: AmountAdjustment[];
  /** One short factual clause the message may quote. Empty when the origin says it all. */
  note: string;
}

/** A line whose intention the model changed this cycle, traded or not. */
export interface IntentRevision {
  asset: string;
  fromPercent: number | null;
  toPercent: number;
  traded: boolean;
}

/** A leg the gate dropped, with the layer whose plan carried it. */
export interface AttributedDroppedLeg extends ProvenanceLeg {
  /**
   * The dropped vector is the one the gate JUDGED — the band's corrected plan when the
   * pilot corrected — so a dropped leg is not necessarily the model's. `modele` when the
   * model's own plan carried that leg on a line it revised, `derive` when its own plan
   * carried it on an unchanged line, `bande` when the band's correction moved the line
   * that way, `non_etablie` otherwise.
   */
  origin: 'modele' | 'derive' | 'bande' | 'non_etablie';
}

export interface AttributedGate {
  refused: boolean;
  reason: string;
  droppedLegs: AttributedDroppedLeg[];
}

export interface CycleAttribution {
  movements: AttributedMovement[];
  /** Whether a reference existed to judge the model's intention against. */
  hasIntentReference: boolean;
  /** Every line the model revised this cycle, from the reference to the target. */
  revisions: IntentRevision[];
  /** The band's summary, when it corrected and at least one booked movement is its doing. */
  band: BandFact | null;
  stopExits: StopExitFact[];
  gate: AttributedGate | null;
}

const changed = (a: number, b: number): boolean => Math.abs(a - b) > PROVENANCE_EPSILON;

/** A percentage or a number of points as a French reader expects it: `2,15`, `−1,87`. */
const fmtPct = (n: number): string => {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded).replace('.', ',').replace('-', '−');
};

/**
 * Attributes each booked movement to the layer that caused it. Pure, total, deterministic.
 *
 * `booked` is the ledger fact the notification already builds (side = sign of the base
 * delta, dollars = |quoteDelta|). A null provenance — a decided result assembled without
 * one — attributes nothing: every movement is `non_etablie`, which is the honest reading of
 * "the facts were not carried".
 */
export function attributeCycle(
  provenance: CycleProvenance | null,
  booked: ReadonlyArray<{ asset: string; side: 'buy' | 'sell'; usd: number }>,
): CycleAttribution {
  if (provenance == null) {
    return {
      movements: booked.map((m) => ({
        ...m,
        origin: 'non_etablie',
        intentChange: null,
        adjustments: [],
        note: 'provenance non transmise par le cycle',
      })),
      hasIntentReference: false,
      revisions: [],
      band: null,
      stopExits: [],
      gate: null,
    };
  }

  const { reserveAsset, target, clamped, intentReference, appliedReference, appliedReferenceDivergence, modelLegs, band, stopExits, gate } = provenance;
  const gateDisplaced = appliedReferenceDivergence != null;
  const stopped = new Map(stopExits.map((s) => [s.asset, s]));
  const bandLine = new Map((band?.lines ?? []).map((l) => [l.asset, l]));
  const modelLeg = new Map(modelLegs.map((l) => [l.asset, l]));

  /**
   * DID THE MODEL CHANGE ITS INTENTION ON THIS LINE. `null` when there is no reference to
   * compare with. A line the reference does not carry that now receives weight is a change
   * (the guard's `openedOutside`); one it does not carry and that stays at zero is not.
   */
  const intentChangeOf = (asset: string): { changed: boolean; from: number | null } | null => {
    if (intentReference == null) return null;
    const to = target[asset] ?? 0;
    const from = intentReference[asset];
    if (from == null) return { changed: Math.abs(to) > PROVENANCE_EPSILON, from: null };
    return { changed: changed(to, from), from };
  };

  // EVERY line the model revised, stopped ones included: the stop owns the booked movement,
  // but a model that itself took a stopped line to zero did revise it, and a summary that
  // dropped that revision would read "maintien" under a stop note saying the model was
  // exiting the line on its own. The raw target is compared, not the stop-flattened intent.
  const revisions: IntentRevision[] = [];
  const bookedAssets = new Set(booked.map((m) => m.asset));
  if (intentReference != null) {
    for (const asset of new Set([...Object.keys(target), ...Object.keys(intentReference)])) {
      if (asset === reserveAsset) continue; // the cash side follows the lines; it is not a line
      const change = intentChangeOf(asset);
      if (change?.changed) {
        revisions.push({ asset, fromPercent: change.from, toPercent: target[asset] ?? 0, traded: bookedAssets.has(asset) });
      }
    }
    revisions.sort((a, b) => a.asset.localeCompare(b.asset));
  }

  const movements: AttributedMovement[] = booked.map((m) => {
    const { asset, side } = m;
    const base = { asset, side, usd: m.usd };
    const sideSign = side === 'buy' ? 1 : -1;
    const stop = stopped.get(asset);
    const line = bandLine.get(asset);
    const bandPoints = line?.correctionPoints ?? 0;
    const bandTouched = Math.abs(bandPoints) > PROVENANCE_EPSILON;
    const clampTouched = changed(target[asset] ?? 0, clamped[asset] ?? 0);
    const own = modelLeg.get(asset);
    const ownSameSide = own != null && own.side === side;
    const change = intentChangeOf(asset);

    // ── 1. A protective exit is the operational cause before anything else ──────────
    if (stop != null) {
      const intended = target[asset] ?? 0;
      return {
        ...base,
        origin: 'stop',
        intentChange: null,
        adjustments: [],
        note:
          intended > PROVENANCE_EPSILON
            ? `remplace l'intention du modèle (${asset} ${fmtPct(intended)} %)`
            : `le modèle sortait lui-même la ligne`,
      };
    }

    // The size adjustments a model-decided movement carries, named per layer.
    const adjustments = (): AmountAdjustment[] => {
      const list: AmountAdjustment[] = [];
      if (clampTouched) list.push({ layer: 'plafond_de_risque', fromPercent: target[asset] ?? 0, toPercent: clamped[asset] ?? 0 });
      if (bandTouched && own != null) list.push({ layer: 'bande', points: bandPoints, modelPlanNotional: own.notional });
      return list;
    };

    // ── 2. No reference: only what the chain can prove ───────────────────────────────
    if (change == null) {
      if (bandTouched) {
        return { ...base, origin: 'bande', intentChange: null, adjustments: [], note: bandNote(line!, band!) };
      }
      // Its own plan produces this very movement and no chain reference exists that could
      // have displaced the line: the model's. The risk clamp only RESIZES a line — it never
      // flips a side — so a clamped first plan keeps its origin and names the cap.
      if (ownSameSide && appliedReference == null) {
        return {
          ...base,
          origin: 'modele',
          intentChange: { fromPercent: null, toPercent: target[asset] ?? 0 },
          adjustments: clampTouched ? [{ layer: 'plafond_de_risque', fromPercent: target[asset] ?? 0, toPercent: clamped[asset] ?? 0 }] : [],
          note: 'première intention enregistrée sur cette ligne — le plan initial du modèle produit ce mouvement',
        };
      }
      return { ...base, origin: 'non_etablie', intentChange: null, adjustments: [], note: 'aucune intention de référence pour juger la ligne' };
    }

    // ── 3. The model changed its intention on this line ──────────────────────────────
    if (change.changed) {
      const intentChange = { fromPercent: change.from, toPercent: target[asset] ?? 0 };
      if (ownSameSide) {
        return { ...base, origin: 'modele', intentChange, adjustments: adjustments(), note: '' };
      }
      // Its own plan does not trade the line this way. If the band touched it, the band is
      // the cause — against the model when the model's change pointed the other way.
      if (bandTouched) {
        const changeSign = Math.sign((target[asset] ?? 0) - (change.from ?? 0));
        const against = own != null || (changeSign !== 0 && changeSign !== sideSign);
        return {
          ...base,
          origin: against ? 'bande_contre_modele' : 'bande',
          intentChange,
          adjustments: [],
          note: against
            ? `le modèle ${changeSign < 0 ? 'allégeait' : 'renforçait'} ${asset} (${fmtPct(change.from ?? 0)} → ${fmtPct(target[asset] ?? 0)} %) ; ${bandNote(line!, band!)}`
            : `la révision du modèle (${fmtPct(change.from ?? 0)} → ${fmtPct(target[asset] ?? 0)} %) ne tradait pas seule ; ${bandNote(line!, band!)}`,
        };
      }
      return { ...base, origin: 'non_etablie', intentChange, adjustments: [], note: 'intention révisée mais aucun plan ni aucune couche ne produit ce mouvement' };
    }

    // ── 4. The intention on this line is unchanged: the movement is the chain's ──────
    const intent = intentReference![asset];
    const applied = appliedReference?.[asset];
    const displaced = intent != null && applied != null && changed(applied, intent);
    // Lifted by the BAND, provably: above the intention, and not because a gate refusal kept
    // the previous vector while the intention went down (see `appliedReferenceDivergence`).
    const liftedBefore = displaced && applied! > intent! && !gateDisplaced;
    const towardIntent = intent != null && applied != null && Math.sign(intent - applied) === sideSign;
    // The band moved this line the OTHER way than the movement: it did not cause it, it
    // resized it. Carried as an adjustment on the drift or the return the own plan proves.
    const softenedByBand: AmountAdjustment[] =
      bandTouched && own != null && Math.sign(bandPoints) !== sideSign ? [{ layer: 'bande', points: bandPoints, modelPlanNotional: own.notional }] : [];
    if (bandTouched && Math.sign(bandPoints) === sideSign) {
      // The band's points and the trade point the same way: the band moved the line.
      return { ...base, origin: 'bande', intentChange: null, adjustments: [], note: bandNote(line!, band!) };
    }
    if (bandTouched && displaced && !gateDisplaced && line != null && closerOnTheSameSide(line.correctedWeightPercent, applied!, intent!)) {
      // Opposite ways, and the corrected target comes STRICTLY CLOSER to the intention than
      // the previous applied, on the same side of it: the band is moving its own correction
      // back toward the intention (2115 BNB: +1.84 on a line going from 14.5 to 11.84, the
      // book selling down to the new, lower hold). Symmetric below the intention — a line the
      // chain had left under it, that the band now holds nearer to it. The same distance,
      // farther away, or across the intention is NOT that: the band then only resized a
      // drift or a return, handled below.
      return {
        ...base,
        origin: 'bande_deplacement',
        intentChange: null,
        adjustments: [],
        note:
          applied! > intent!
            ? `${asset}, porté à ${fmtPct(applied!)} % par la correction précédente, est ramené à ${fmtPct(line.correctedWeightPercent)} % (${bandBound(band!)})`
            : `la chaîne avait laissé ${asset} à ${fmtPct(applied!)} % sous l'intention du modèle (${fmtPct(intent!)} %) ; la bande le remonte à ${fmtPct(line.correctedWeightPercent)} % (${bandBound(band!)})`,
      };
    }
    if (bandTouched && !ownSameSide) {
      // Opposite ways and no own leg to soften: a correction against the movement cannot
      // have produced it, and nothing else on record did.
      return { ...base, origin: 'non_etablie', intentChange: null, adjustments: [], note: `la bande a corrigé ${asset} à l'opposé du mouvement et aucun plan ne le porte` };
    }
    if (!bandTouched && liftedBefore && towardIntent) {
      // The band did NOT touch the line this cycle, and the line sat above the intention with
      // no refusal on the reference row: the band's lift, proven by the two references and
      // the divergence cause (see `liftedBefore`), that the band no longer holds — 2141 XRP.
      // When the band DID touch the line, the closer-same-side test above is the only way
      // to this origin.
      const liftedNow = (band?.lines ?? []).filter((l) => l.correctionPoints > PROVENANCE_EPSILON).map((l) => l.asset);
      return {
        ...base,
        origin: 'bande_deplacement',
        intentChange: null,
        adjustments: [],
        note:
          `${asset}, porté à ${fmtPct(applied!)} % par la correction précédente, revient à la cible du modèle (${fmtPct(intent!)} %) — ` +
          (liftedNow.length > 0 ? `la bande porte désormais ses points sur ${liftedNow.join(', ')}` : 'la bande ne le tient plus'),
      };
    }
    if (displaced && towardIntent && ownSameSide) {
      return {
        ...base,
        origin: 'retour_vers_cible',
        intentChange: null,
        adjustments: softenedByBand,
        // With a refusal on the reference row the note states the refusal and the line's
        // position, and nothing about WHICH layer put the line there: the refused legs of
        // that cycle are not in hand, and the kept vector may carry an older band lift.
        note: gateDisplaced
          ? `la porte de transition avait refusé le vecteur précédent ; ${asset} était resté à ${fmtPct(applied!)} % ${applied! > intent! ? 'au-dessus de' : 'sous'} l'intention du modèle (${fmtPct(intent!)} %) et y revient`
          : `la chaîne avait laissé ${asset} à ${fmtPct(applied!)} % sous la cible du modèle (${fmtPct(intent!)} %) ; la ligne y revient`,
      };
    }
    if (!displaced && ownSameSide) {
      return {
        ...base,
        origin: 'derive',
        intentChange: null,
        adjustments: softenedByBand,
        note: `cible maintenue à ${fmtPct(intent ?? target[asset] ?? 0)} % ; le livre avait dérivé par les prix`,
      };
    }
    return { ...base, origin: 'non_etablie', intentChange: null, adjustments: [], note: 'intention inchangée, aucune couche identifiée' };
  });

  // The gate's dropped legs, each with the layer whose plan carried it — see AttributedDroppedLeg.
  const droppedLegs: AttributedDroppedLeg[] = gate.droppedLegs.map((leg) => {
    const own = modelLeg.get(leg.asset);
    const line = bandLine.get(leg.asset);
    const legSign = leg.side === 'buy' ? 1 : -1;
    const change = intentChangeOf(leg.asset);
    if (own != null && own.side === leg.side) {
      return { ...leg, origin: change == null || change.changed ? 'modele' : 'derive' };
    }
    if (line != null && Math.abs(line.correctionPoints) > PROVENANCE_EPSILON && Math.sign(line.correctionPoints) === legSign) {
      return { ...leg, origin: 'bande' };
    }
    return { ...leg, origin: 'non_etablie' };
  });

  const bandCaused = movements.some(
    (m) =>
      m.origin === 'bande' ||
      m.origin === 'bande_deplacement' ||
      m.origin === 'bande_contre_modele' ||
      m.adjustments.some((a) => a.layer === 'bande'),
  );
  return {
    movements,
    hasIntentReference: intentReference != null,
    revisions,
    band: bandCaused ? band : null,
    stopExits,
    gate: gate.refused ? { refused: true, reason: gate.reason, droppedLegs } : null,
  };
}

/**
 * Is `next` strictly closer to `intent` than `previous`, without crossing it. The one test
 * that decides whether a correction opposing the movement is the band MOVING its own
 * correction (closer, same side) or merely resizing a drift or a return (same distance,
 * farther, or across the intention). Landing exactly on the intention counts as closer.
 */
export function closerOnTheSameSide(next: number, previous: number, intent: number): boolean {
  const before = previous - intent;
  const after = next - intent;
  if (Math.abs(after) >= Math.abs(before) - PROVENANCE_EPSILON) return false;
  return Math.abs(after) <= PROVENANCE_EPSILON || Math.sign(after) === Math.sign(before);
}

/** The bound the band moved the target to, named. */
function bandBound(band: BandFact): string {
  return band.boundPercent != null ? `${band.direction === 'up' ? 'plancher' : 'plafond'} ${fmtPct(band.boundPercent)} %` : 'bande';
}

/** The band's own clause for a line it corrected. */
function bandNote(line: BandLineFact, band: BandFact): string {
  const points = `${line.correctionPoints > 0 ? '+' : ''}${fmtPct(line.correctionPoints)} pt${Math.abs(line.correctionPoints) >= 2 ? 's' : ''}`;
  const bound = bandBound(band);
  if (line.origin === 'allocation_de_secours') {
    return `ligne ouverte par la bande (${points}, ${bound}), sans conviction du modèle`;
  }
  return `${points} (${bound})`;
}

export { fmtPct as formatPercent };
