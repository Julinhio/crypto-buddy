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
 *     last intention on it — only the band ever lifts a line above the intention — and this
 *     cycle the band no longer holds it there, so the line returns to the model's target.
 *     That is 2141 XRP: `origin = modele` in the journal, `correction_points = 0`, and yet
 *     not a decision of the model's, which had not changed its mind about XRP since 2139;
 *   - the band AGAINST the model: the model changed its intention on the line and the
 *     correction moved it the other way (or beyond a change too small to trade);
 *   - a RETURN to the target: the chain had left the line BELOW the intention (the risk
 *     clamp or a downward correction — the two are not separable from the references
 *     alone, so the layer is named as "the chain") and the line climbs back toward it;
 *   - DRIFT: the line's applied target WAS the intention, nothing changed, and the book
 *     moved by prices past the floor. The standing target reasserts itself. Not a decision;
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

export interface CycleAttribution {
  movements: AttributedMovement[];
  /** Whether a reference existed to judge the model's intention against. */
  hasIntentReference: boolean;
  /** Every line the model revised this cycle, from the reference to the target. */
  revisions: IntentRevision[];
  /** The band's summary, when it corrected and at least one booked movement is its doing. */
  band: BandFact | null;
  stopExits: StopExitFact[];
  gate: GateFact | null;
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

  const { reserveAsset, target, clamped, intentReference, appliedReference, modelLegs, band, stopExits, gate } = provenance;
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

  const revisions: IntentRevision[] = [];
  const bookedAssets = new Set(booked.map((m) => m.asset));
  if (intentReference != null) {
    for (const asset of new Set([...Object.keys(target), ...Object.keys(intentReference)])) {
      if (asset === reserveAsset) continue; // the cash side follows the lines; it is not a line
      if (stopped.has(asset)) continue; // the stop owns the line; the intent is forced flat on it
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
      if (ownSameSide && !clampTouched && appliedReference == null) {
        return {
          ...base,
          origin: 'modele',
          intentChange: { fromPercent: null, toPercent: target[asset] ?? 0 },
          adjustments: [],
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
    const liftedBefore = displaced && applied! > intent!;
    if (bandTouched) {
      // The band's points and the trade point the same way: the band moved the line.
      if (Math.sign(bandPoints) === sideSign) {
        return { ...base, origin: 'bande', intentChange: null, adjustments: [], note: bandNote(line!, band!) };
      }
      // They point OPPOSITE ways — the band ADDED points to a line that SELLS (2115 BNB:
      // +1.84 on a line going from 14.5 to 11.84). The line was sitting above the intention
      // because a previous correction lifted it, and this cycle's correction holds it lower:
      // the band is shrinking its own displacement, not pushing the line.
      if (liftedBefore && line != null && changed(line.correctedWeightPercent, applied!)) {
        return {
          ...base,
          origin: 'bande_deplacement',
          intentChange: null,
          adjustments: [],
          note: `${asset}, porté à ${fmtPct(applied!)} % par la correction précédente, est ramené à ${fmtPct(line.correctedWeightPercent)} % (${bandBound(band!)})`,
        };
      }
      return { ...base, origin: 'bande', intentChange: null, adjustments: [], note: bandNote(line!, band!) };
    }
    const towardIntent = intent != null && applied != null && Math.sign(intent - applied) === sideSign;
    if (liftedBefore && towardIntent) {
      // Only the band ever lifts a line above the intention: the previous correction is the
      // band's, proven by the two references alone.
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
    if (displaced && towardIntent) {
      return {
        ...base,
        origin: 'retour_vers_cible',
        intentChange: null,
        adjustments: [],
        note: `la chaîne avait laissé ${asset} à ${fmtPct(applied!)} % sous la cible du modèle (${fmtPct(intent!)} %) ; la ligne y revient`,
      };
    }
    if (!displaced && ownSameSide) {
      return {
        ...base,
        origin: 'derive',
        intentChange: null,
        adjustments: [],
        note: `cible maintenue à ${fmtPct(intent ?? target[asset] ?? 0)} % ; le livre avait dérivé par les prix`,
      };
    }
    return { ...base, origin: 'non_etablie', intentChange: null, adjustments: [], note: 'intention inchangée, aucune couche identifiée' };
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
    gate: gate.refused ? gate : null,
  };
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
