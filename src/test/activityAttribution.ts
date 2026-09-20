import assert from 'node:assert/strict';
import { attributeCycle, type CycleProvenance, type BandFact } from '../decision/provenance.js';
import { formatActivity, prepareActivityNotification, type ActivityNotification } from '../alerting/activity.js';
import type { DecideResult } from '../decision/decide.js';
import { Decimal } from '../money.js';

/**
 * WHO MOVED EACH LINE — the attribution the activity notification carries since PR 2 of the
 * guard/band incident, proven on the four real cycles the brief named (rebuilt here with
 * their journaled numbers, rounded) and on the synthetic cases that bracket the frontier.
 *
 * The frontier is `provenance.ts`'s header. What this file pins:
 *
 *   - a stop is the cause before anything else, and says it replaced the intention (2051);
 *   - a hold the band lifted attributes NOTHING to the model (2112);
 *   - a real revision keeps its origin AND names the layer that resized it — one origin
 *     per movement, never a merged "mixed" that hides who decided (2139);
 *   - a hold whose book moves because the band moved its correction elsewhere is the
 *     band's doing, not a fresh decision to sell (2141) — and the same when the band only
 *     shrinks its previous lift (2115);
 *   - a fully model-decided cycle stays the model's; a cycle with nothing booked sends
 *     nothing; and without an intention reference only deterministic layers and an
 *     unopposed own plan are attributed — the rest is `non_etablie`, never guessed.
 */

let passed = 0;
const ok = (label: string, condition: boolean): void => {
  assert.ok(condition, label);
  console.log(`  ok: ${label}`);
  passed += 1;
};

const RESERVE = 'USDT';
const floorBand = (over: Partial<BandFact> & { lines: BandFact['lines'] }): BandFact => ({
  direction: 'up',
  label: 'hausse_vers_plancher',
  boundPercent: 45,
  targetExposurePercent: 39,
  correctedExposurePercent: 45,
  unrealisablePoints: 0,
  consolidated: false,
  ...over,
});
const noGate = { refused: false, reason: '', droppedLegs: [] };
const base = (over: Partial<CycleProvenance>): CycleProvenance => ({
  reserveAsset: RESERVE,
  target: {},
  clamped: {},
  clampReason: null,
  intentReference: null,
  appliedReference: null,
  appliedReferenceDivergence: null,
  modelLegs: [],
  band: null,
  stopExits: [],
  gate: noGate,
  ...over,
});
const notification = (
  provenance: CycleProvenance | null,
  movements: Array<{ asset: string; side: 'buy' | 'sell'; usd: number }>,
  reasoning = 'raisonnement du modèle',
): ActivityNotification => ({
  timestamp: '2026-09-19T18:00:57Z',
  movements,
  attribution: attributeCycle(provenance, movements),
  modelReasoning: reasoning,
  allocation: [{ label: 'BTC', weight: 16 }, { label: 'cash', weight: 84 }],
  totalUsd: 1090,
});

console.log('\n2051 — the peak stop sells XRP under a hold:');
{
  const target = { BNB: 13, BTC: 8.75, ETH: 10, XRP: 13, USDT: 55.25 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { ...target },
    appliedReference: { ...target },
    // The model's own plan: every line under the floor — nothing of its own trades.
    modelLegs: [],
    band: floorBand({ direction: 'none', label: 'aucune_correction', boundPercent: null, targetExposurePercent: 31.75, correctedExposurePercent: 31.75, lines: [
      { asset: 'XRP', correctionPoints: 0, origin: 'modele', cause: 'gel', baseWeightPercent: 0, correctedWeightPercent: 0 },
    ] }),
    stopExits: [{ asset: 'XRP', notional: 142.09, drawdownFromPeakPercent: -12.796, thresholdPercent: 10 }],
  });
  const n = notification(prov, [{ asset: 'XRP', side: 'sell', usd: 141.95 }], 'Maintien de toutes les positions. BTC et ETH sous leur EMA21 journalière.');
  const [xrp] = n.attribution.movements;
  ok('the XRP sale is the STOP\'s', xrp!.origin === 'stop');
  ok('and it says it replaced the model\'s standing intention on the line', xrp!.note.includes("remplace l'intention du modèle (XRP 13 %)"));
  ok('the model is read as a hold: no line revised', n.attribution.revisions.length === 0 && n.attribution.hasIntentReference);
  const text = formatActivity(n);
  ok('the movement line names the stop, not the model', text.includes('Vente ~142$ de XRP — stop de pic (code)'));
  ok('the model line says maintien', text.includes('Modèle : maintien, aucune ligne révisée.'));
  ok('the stop line carries the drawdown and the threshold', text.includes("Stop de pic : sortie totale de XRP (12,8 % sous le pic pendant une transition, seuil 10 %) — remplace l'intention du modèle (XRP 13 %)."));
  ok('the model\'s text is labelled as its reasoning, and no global "Pourquoi" remains', text.includes('Raisonnement du modèle : Maintien de toutes') && !text.includes('Pourquoi'));
  ok('no band line: the band moved nothing', !text.includes('Bande :'));
  // The model ITSELF took the stopped line to zero this cycle: the exit is still the
  // stop's, and the revision is still listed — the summary must not read "maintien"
  // under a stop note saying the model was exiting the line on its own.
  const exiting = notification({ ...prov, target: { ...target, XRP: 0, USDT: 68.25 }, clamped: { ...target, XRP: 0, USDT: 68.25 } }, [{ asset: 'XRP', side: 'sell', usd: 141.95 }]);
  ok('a stopped line the model also zeroed keeps the stop as origin and says the model was exiting itself', exiting.attribution.movements[0]!.origin === 'stop' && exiting.attribution.movements[0]!.note === 'le modèle sortait lui-même la ligne');
  ok('and the revision is listed, marked as exited by the stop', exiting.attribution.revisions.length === 1 && formatActivity(exiting).includes('Modèle : révision XRP 13 → 0 % (ligne sortie par le stop).'));
  // The same stop, but its exit never booked (a venue filter) while another line did.
  const unbooked = notification({ ...prov, stopExits: prov.stopExits, band: null, modelLegs: [{ asset: 'BTC', side: 'sell', notional: 30 }], target: { ...target, BTC: 5 } }, [{ asset: 'BTC', side: 'sell', usd: 30 }]);
  ok('a stop exit the ledger does not carry is reported as NOT booked, never as an exit that happened', formatActivity(unbooked).includes("Stop de pic : sortie totale de XRP générée par le code (12,8 % sous le pic pendant une transition, seuil 10 %) — NON comptabilisée ce cycle, voir le journal d'exécution."));
}

console.log('\n2112 — the band lifts a hold from 33.75% to the 45% floor:');
{
  const target = { BNB: 10, BTC: 8.75, ETH: 10, XRP: 5, USDT: 66.25 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { ...target },
    appliedReference: { ...target },
    modelLegs: [],
    band: floorBand({ targetExposurePercent: 33.75, lines: [
      { asset: 'BNB', correctionPoints: 4.5, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 14.5 },
      { asset: 'BTC', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 8.75, correctedWeightPercent: 8.75 },
      { asset: 'ETH', correctionPoints: 4.5, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 14.5 },
      { asset: 'XRP', correctionPoints: 2.25, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 5, correctedWeightPercent: 7.25 },
    ] }),
  });
  const n = notification(prov, [
    { asset: 'BNB', side: 'buy', usd: 47.95 },
    { asset: 'ETH', side: 'buy', usd: 40.88 },
    { asset: 'XRP', side: 'buy', usd: 25.42 },
  ], 'Aucune action ce cycle — tous les actifs restent sous leurs seuils d\'allègement.');
  ok('all three buys are the band\'s', n.attribution.movements.every((m) => m.origin === 'bande'));
  ok('none is the model\'s', !n.attribution.movements.some((m) => m.origin === 'modele'));
  const text = formatActivity(n);
  ok('each movement line is tagged "bande"', ['Achat ~48$ de BNB — bande', "Achat ~41$ d'ETH — bande", 'Achat ~25$ de XRP — bande'].every((l) => text.includes(l)));
  ok('the model line says maintien', text.includes('Modèle : maintien, aucune ligne révisée.'));
  ok('the band line names the floor and each line\'s points', text.includes('Bande : exposition cible 33,75 % relevée au plancher 45 % — BNB +4,5 pts, ETH +4,5 pts, XRP +2,25 pts.'));
  ok('the model\'s "aucune action" is its reasoning, under its own label', text.includes('Raisonnement du modèle : Aucune action ce cycle'));
}

console.log('\n2139 — the model trims ETH; the band buys BTC and XRP and resizes the ETH sale:');
{
  const target = { BNB: 9, BTC: 14, ETH: 3, XRP: 13, USDT: 61 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { BNB: 9, BTC: 14, ETH: 9, XRP: 13, USDT: 55 },
    appliedReference: { BNB: 9, BTC: 14, ETH: 9, XRP: 13, USDT: 55 },
    // Its own plan: the ETH trim, sized on the uncorrected target (9.02% → 3%).
    modelLegs: [{ asset: 'ETH', side: 'sell', notional: 65.66 }],
    band: floorBand({ lines: [
      { asset: 'BNB', correctionPoints: 1.384615, origin: 'correction_de_bande', cause: 'seuil_de_mouvement', baseWeightPercent: 9, correctedWeightPercent: 10.384615 },
      { asset: 'BTC', correctionPoints: 2.153846, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 14, correctedWeightPercent: 16.153846 },
      { asset: 'ETH', correctionPoints: 0.461538, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 3, correctedWeightPercent: 3.461538 },
      { asset: 'XRP', correctionPoints: 2, origin: 'correction_de_bande', cause: 'plafond_individuel', baseWeightPercent: 13, correctedWeightPercent: 15 },
    ] }),
  });
  const n = notification(prov, [
    { asset: 'ETH', side: 'sell', usd: 60.5 },
    { asset: 'XRP', side: 'buy', usd: 31.45 },
    { asset: 'BTC', side: 'buy', usd: 29.35 },
  ], 'ETH taillé à 3% : prix à $2 644, essentiellement au plus haut mensuel.');
  const by = new Map(n.attribution.movements.map((m) => [m.asset, m]));
  ok('the ETH sale is the MODEL\'s (its intention on ETH went 9 → 3 and its own plan sells)', by.get('ETH')!.origin === 'modele' && by.get('ETH')!.intentChange?.fromPercent === 9);
  ok('and it carries the band as the layer that resized it, with the model\'s own plan amount', by.get('ETH')!.adjustments.some((a) => a.layer === 'bande' && a.modelPlanNotional === 65.66));
  ok('the BTC and XRP buys are the band\'s', by.get('BTC')!.origin === 'bande' && by.get('XRP')!.origin === 'bande');
  ok('one origin per movement — a resized decision is not flattened into "mixed"', by.get('ETH')!.origin === 'modele' && by.get('ETH')!.adjustments.length === 1);
  const text = formatActivity(n);
  ok('the ETH line: model, resized by the band', text.includes("Vente ~61$ d'ETH — modèle, montant ajusté par la bande"));
  ok('the model line names the revision and what its initial plan would have sold', text.includes("Modèle : révision ETH 9 → 3 % (son plan initial aurait vendu ~66$ d'ETH)."));
  ok('the band line names the floor and the lines it lifted, largest first', text.includes('Bande : exposition cible 39 % relevée au plancher 45 % — BTC +2,15 pts, XRP +2 pts (plafond individuel), BNB +1,38 pt (sous le seuil), ETH +0,46 pt.'));
  ok('the buys are tagged "bande"', text.includes('Achat ~31$ de XRP — bande') && text.includes('Achat ~29$ de BTC — bande'));
}

console.log('\n2141 — a hold; the band moves its correction from XRP to BTC:');
{
  const target = { BNB: 9, BTC: 14, ETH: 3, XRP: 13, USDT: 61 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { ...target },
    // The chain's last applied: 2139's band-corrected vector — XRP at 15, above the model's 13.
    appliedReference: { BNB: 10.384615, BTC: 16.153846, ETH: 3.461538, XRP: 15, USDT: 55 },
    // Its own plan against the book (XRP 15.73%): the sale back to 13 — which is NOT a decision.
    modelLegs: [{ asset: 'XRP', side: 'sell', notional: 29.76 }],
    band: floorBand({ consolidated: true, lines: [
      { asset: 'BNB', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 9, correctedWeightPercent: 9 },
      { asset: 'BTC', correctionPoints: 6, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 14, correctedWeightPercent: 20 },
      { asset: 'ETH', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 3, correctedWeightPercent: 3 },
      { asset: 'XRP', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 13, correctedWeightPercent: 13 },
    ] }),
  });
  const n = notification(prov, [
    { asset: 'BTC', side: 'buy', usd: 30.16 },
    { asset: 'XRP', side: 'sell', usd: 29.7 },
  ], 'Portefeuille maintenu : aucun déclencheur de sortie atteint.');
  const by = new Map(n.attribution.movements.map((m) => [m.asset, m]));
  ok('the BTC buy is the band\'s', by.get('BTC')!.origin === 'bande');
  ok('the XRP sale is the band MOVING its correction — not a fresh decision of the model\'s', by.get('XRP')!.origin === 'bande_deplacement');
  ok('proven by the references alone: the last applied (15) sat above the last intention (13) on XRP', by.get('XRP')!.note.includes('XRP, porté à 15 % par la correction précédente') && by.get('XRP')!.note.includes('revient à la cible du modèle (13 %)'));
  ok('the model revised nothing', n.attribution.revisions.length === 0);
  const text = formatActivity(n);
  ok('the XRP line is tagged as the band\'s displacement', text.includes('Vente ~30$ de XRP — bande (déplacement de correction)'));
  ok('the model line says maintien', text.includes('Modèle : maintien, aucune ligne révisée.'));
  ok('the band line: floor, BTC +6 with consolidation, XRP back to the model\'s target', text.includes('Bande : exposition cible 39 % relevée au plancher 45 % (consolidation) — BTC +6 pts ; XRP, porté à 15 % par la correction précédente, revient à la cible du modèle (13 %) — la bande porte désormais ses points sur BTC.'));
}

console.log('\n2115 — the band shrinks its own previous lift (points added, line sells):');
{
  const target = { BNB: 10, BTC: 8.75, ETH: 14.5, XRP: 5, USDT: 61.75 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { BNB: 10, BTC: 8.75, ETH: 10, XRP: 5, USDT: 66.25 },
    appliedReference: { BNB: 14.5, BTC: 8.75, ETH: 14.5, XRP: 7.25, USDT: 55 },
    // Its own plan: the BNB sale back to 10 (the book sat at 14.5); ETH 14.5 is where the book already is.
    modelLegs: [{ asset: 'BNB', side: 'sell', notional: 49 }],
    band: floorBand({ targetExposurePercent: 38.25, lines: [
      { asset: 'BNB', correctionPoints: 1.836735, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 11.836735 },
      { asset: 'ETH', correctionPoints: 2.663265, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 14.5, correctedWeightPercent: 17.163265 },
    ] }),
  });
  const n = notification(prov, [{ asset: 'BNB', side: 'sell', usd: 29 }, { asset: 'ETH', side: 'buy', usd: 23 }]);
  const by = new Map(n.attribution.movements.map((m) => [m.asset, m]));
  ok('BNB: +1.84 points on a line that SELLS is the band lowering its previous lift (14.5 → 11.84), not pushing the line', by.get('BNB')!.origin === 'bande_deplacement' && by.get('BNB')!.note.includes('BNB, porté à 14,5 % par la correction précédente, est ramené à 11,84 %'));
  ok('ETH: the model raised its intention (10 → 14.5) but its own plan does not buy (the book was already there); the band lifted the line further — the buy is the band\'s, and the note says the revision did not trade on its own', by.get('ETH')!.origin === 'bande' && by.get('ETH')!.note.includes('ne tradait pas seule'));
  ok('the model line lists the ETH revision as one without a movement of its own', formatActivity(n).includes('Modèle : révision ETH 10 → 14,5 % (sans mouvement propre).'));
}

console.log('\nA fully model-decided cycle stays the model\'s:');
{
  const target = { BNB: 10, BTC: 9, ETH: 12, XRP: 8, USDT: 61 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { BNB: 15, BTC: 9, ETH: 12, XRP: 8, USDT: 56 },
    appliedReference: { BNB: 15, BTC: 9, ETH: 12, XRP: 8, USDT: 56 },
    modelLegs: [{ asset: 'BNB', side: 'sell', notional: 57 }],
    band: floorBand({ direction: 'none', label: 'aucune_correction', boundPercent: null, targetExposurePercent: 39, correctedExposurePercent: 39, lines: [
      { asset: 'BNB', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 10 },
    ] }),
  });
  const n = notification(prov, [{ asset: 'BNB', side: 'sell', usd: 57 }]);
  ok('the sale is the model\'s, with no adjustment', n.attribution.movements[0]!.origin === 'modele' && n.attribution.movements[0]!.adjustments.length === 0);
  const text = formatActivity(n);
  ok('rendered as "modèle" with the revision named', text.includes('Vente ~57$ de BNB — modèle') && text.includes('Modèle : révision BNB 15 → 10 %.'));
  ok('no band line, no stop line', !text.includes('Bande :') && !text.includes('Stop de pic'));
}

console.log('\nThe frontier\'s other sides — synthetic:');
{
  // The band AGAINST the model: the model trims XRP 13 → 12 (its own plan sells), the band
  // lifts the line to 15 and the book BUYS.
  const target = { XRP: 12, USDT: 88 };
  const prov = base({
    target,
    clamped: target,
    intentReference: { XRP: 13, USDT: 87 },
    appliedReference: { XRP: 13, USDT: 87 },
    modelLegs: [{ asset: 'XRP', side: 'sell', notional: 25 }],
    band: floorBand({ targetExposurePercent: 12, boundPercent: 15, lines: [{ asset: 'XRP', correctionPoints: 3, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 12, correctedWeightPercent: 15 }] }),
  });
  const n = notification(prov, [{ asset: 'XRP', side: 'buy', usd: 30 }]);
  ok('a buy against the model\'s trim is the band AGAINST the model, and the note names both', n.attribution.movements[0]!.origin === 'bande_contre_modele' && n.attribution.movements[0]!.note.includes('le modèle allégeait XRP (13 → 12 %)'));
  ok('rendered as such on the movement line', formatActivity(n).includes("Achat ~30$ de XRP — bande, contre l'intention du modèle"));
}
{
  // DRIFT: intention unchanged, applied = intention, the book drifted past the floor.
  const target = { BTC: 20, USDT: 80 };
  const prov = base({ target, clamped: target, intentReference: { ...target }, appliedReference: { ...target }, modelLegs: [{ asset: 'BTC', side: 'sell', notional: 30 }] });
  const n = notification(prov, [{ asset: 'BTC', side: 'sell', usd: 30 }]);
  ok('a standing target reasserted over price drift is `derive`, not a decision', n.attribution.movements[0]!.origin === 'derive');
  ok('rendered with the maintained target', formatActivity(n).includes('Vente ~30$ de BTC — rééquilibrage de dérive (cible maintenue)') && formatActivity(n).includes('BTC : cible maintenue à 20 %'));
}
{
  // RETURN toward the target: the chain had left the line BELOW the intention (a clamp or
  // a downward correction — not separable), and the line climbs back.
  const target = { BTC: 25, USDT: 75 };
  const prov = base({ target, clamped: target, intentReference: { ...target }, appliedReference: { BTC: 20, USDT: 80 }, modelLegs: [{ asset: 'BTC', side: 'buy', notional: 50 }] });
  const n = notification(prov, [{ asset: 'BTC', side: 'buy', usd: 50 }]);
  ok('the layer is named as "the chain", because the references cannot separate the clamp from a downward correction', n.attribution.movements[0]!.origin === 'retour_vers_cible' && n.attribution.movements[0]!.note.includes('la chaîne avait laissé BTC à 20 %'));
}
{
  // A GATE REFUSAL also leaves the applied target ABOVE the intention: the model lowered
  // XRP 15 → 13, the gate refused the vector, the row kept applied 15 with intent 13 and a
  // divergence cause. Next cycle the model repeats 13 and the line is actionable: the sale
  // is the line rejoining the intention after the refusal — NOT the band moving anything.
  const target = { XRP: 13, USDT: 87 };
  const refused = base({
    target,
    clamped: target,
    intentReference: { ...target },
    appliedReference: { XRP: 15, USDT: 85 },
    appliedReferenceDivergence: 'XRP frozen — 1 strategic leg(s) dropped, applied_allocation holds the previous vector',
    modelLegs: [{ asset: 'XRP', side: 'sell', notional: 25 }],
  });
  const n = notification(refused, [{ asset: 'XRP', side: 'sell', usd: 25 }]);
  ok('an applied target above the intention is NOT read as a band lift when the reference row carries a gate divergence', n.attribution.movements[0]!.origin === 'retour_vers_cible');
  ok('and the note states the refusal and the line\'s position, without claiming which layer put it there', n.attribution.movements[0]!.note === "la porte de transition avait refusé le vecteur précédent ; XRP était resté à 15 % au-dessus de l'intention du modèle (13 %) et y revient");
  // The same references WITHOUT a divergence cause: only the band lifts a line above the
  // intention, so the lift is the band's.
  const lifted = notification(base({ ...refused, appliedReferenceDivergence: null }), [{ asset: 'XRP', side: 'sell', usd: 25 }]);
  ok('without a divergence cause the same lift is the band\'s', lifted.attribution.movements[0]!.origin === 'bande_deplacement');
  // And the band shrinking "its" lift is not claimed either when the gate is the writer.
  const shrunk = notification(base({ ...refused, band: floorBand({ targetExposurePercent: 13, boundPercent: 14, lines: [{ asset: 'XRP', correctionPoints: 1, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 13, correctedWeightPercent: 14 }] }) }), [{ asset: 'XRP', side: 'sell', usd: 12 }]);
  ok('a band lift on a gate-displaced line that still sells is plain "bande", not a shrink of a lift the band never made', shrunk.attribution.movements[0]!.origin === 'bande');
}
{
  // The risk clamp resized a model decision.
  const prov = base({
    target: { BTC: 25, USDT: 75 },
    clamped: { BTC: 20, USDT: 80 },
    clampReason: 'BTC capped at 20',
    intentReference: { BTC: 10, USDT: 90 },
    appliedReference: { BTC: 10, USDT: 90 },
    modelLegs: [{ asset: 'BTC', side: 'buy', notional: 100 }],
  });
  const n = notification(prov, [{ asset: 'BTC', side: 'buy', usd: 100 }]);
  ok('the movement is the model\'s, bounded by the risk cap', n.attribution.movements[0]!.origin === 'modele' && n.attribution.movements[0]!.adjustments.some((a) => a.layer === 'plafond_de_risque'));
  ok('and the model line says so with the bounded weight', formatActivity(n).includes('Modèle : révision BTC 10 → 25 % (borné par le plafond de risque à 20 %).'));
}
{
  // Revisions that did not trade are listed as such; the reserve is never a revision.
  const prov = base({
    target: { BTC: 10, ETH: 5.5, USDT: 84.5 },
    clamped: { BTC: 10, ETH: 5.5, USDT: 84.5 },
    intentReference: { BTC: 0, ETH: 5, USDT: 95 },
    appliedReference: { BTC: 0, ETH: 5, USDT: 95 },
    modelLegs: [{ asset: 'BTC', side: 'buy', notional: 100 }],
  });
  const n = notification(prov, [{ asset: 'BTC', side: 'buy', usd: 100 }]);
  ok('two revisions, none on the reserve', n.attribution.revisions.map((r) => r.asset).join(',') === 'BTC,ETH');
  ok('the untraded one is flagged', formatActivity(n).includes('Modèle : révision BTC 0 → 10 %, ETH 5 → 5,5 % (non tradé).'));
}
{
  // The model opened a line the reference did not carry (a new asset in the universe).
  const prov = base({
    target: { SOL: 5, USDT: 95 },
    clamped: { SOL: 5, USDT: 95 },
    intentReference: { USDT: 100 },
    appliedReference: { USDT: 100 },
    modelLegs: [{ asset: 'SOL', side: 'buy', notional: 50 }],
  });
  const n = notification(prov, [{ asset: 'SOL', side: 'buy', usd: 50 }]);
  ok('an opened line is a revision of the model\'s', n.attribution.movements[0]!.origin === 'modele' && formatActivity(n).includes('Modèle : révision SOL ouvert → 5 %.'));
}

console.log('\nWithout an intention reference — only what the chain can prove:');
{
  const target = { BTC: 10, ETH: 10, XRP: 5, USDT: 75 };
  const bandLines: BandFact['lines'] = [
    { asset: 'BTC', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 10 },
    { asset: 'ETH', correctionPoints: 3, origin: 'correction_de_bande', cause: 'aucune', baseWeightPercent: 10, correctedWeightPercent: 13 },
    { asset: 'XRP', correctionPoints: 0, origin: 'modele', cause: 'aucune', baseWeightPercent: 5, correctedWeightPercent: 5 },
  ];
  const prov = base({
    target,
    clamped: target,
    intentReference: null,
    appliedReference: null,
    modelLegs: [{ asset: 'BTC', side: 'buy', notional: 100 }, { asset: 'XRP', side: 'buy', notional: 50 }],
    band: floorBand({ targetExposurePercent: 25, boundPercent: 28, lines: bandLines }),
    stopExits: [{ asset: 'XRP', notional: 50, drawdownFromPeakPercent: -11, thresholdPercent: 10 }],
  });
  const n = notification(prov, [
    { asset: 'BTC', side: 'buy', usd: 100 },
    { asset: 'ETH', side: 'buy', usd: 30 },
    { asset: 'XRP', side: 'sell', usd: 50 },
  ]);
  const by = new Map(n.attribution.movements.map((m) => [m.asset, m]));
  ok('a stop is still the stop\'s', by.get('XRP')!.origin === 'stop');
  ok('a band-corrected line is still the band\'s', by.get('ETH')!.origin === 'bande');
  ok('a movement the model\'s own plan produces, unopposed by any layer, is the model\'s — with the reference absence named', by.get('BTC')!.origin === 'modele' && by.get('BTC')!.note.includes('première intention enregistrée'));
  // A first plan the RISK CLAMP resized still books the same-side order: the clamp only
  // resizes, never flips a side, so the origin stays the model's and the cap is named.
  const clampedFirst = notification(base({ target: { BTC: 25, USDT: 75 }, clamped: { BTC: 20, USDT: 80 }, clampReason: 'BTC capped', modelLegs: [{ asset: 'BTC', side: 'buy', notional: 200 }] }), [{ asset: 'BTC', side: 'buy', usd: 200 }]);
  ok('a clamped first plan keeps the model\'s origin, resized by the risk cap', clampedFirst.attribution.movements[0]!.origin === 'modele' && clampedFirst.attribution.movements[0]!.adjustments.some((a) => a.layer === 'plafond_de_risque'));
  ok('rendered as such', formatActivity(clampedFirst).includes('Achat ~200$ de BTC — modèle, borné par le plafond de risque'));
  ok('the model line says the reference is absent', formatActivity(n).includes('Modèle : aucune intention de référence'));
  // The same BTC buy with an applied reference but no intention: the chain may have
  // displaced the line and nothing can tell — not established.
  const opposed = notification(base({ ...prov, appliedReference: { BTC: 15, USDT: 85 } }), [{ asset: 'BTC', side: 'buy', usd: 100 }]);
  ok('with an applied reference and no intention, the own-plan movement is NOT established', opposed.attribution.movements[0]!.origin === 'non_etablie');
  // No own leg, no layer: not established, never the model by default.
  const orphan = notification(base({ target, clamped: target, modelLegs: [] }), [{ asset: 'BTC', side: 'buy', usd: 100 }]);
  ok('a movement nothing explains is `non_etablie`', orphan.attribution.movements[0]!.origin === 'non_etablie');
  ok('and the message says so on the line', formatActivity(orphan).includes('Achat ~100$ de BTC — origine non établie') && formatActivity(orphan).includes('BTC : aucune intention de référence pour juger la ligne.'));
}

console.log('\nThe notification contract is unchanged where it must be:');
{
  const dec = (n: number | string) => new Decimal(n);
  const after = {
    reserveAsset: RESERVE,
    startingCapital: dec(1000),
    cash: dec(900),
    equity: dec(1000),
    deployedPercent: dec(10),
    realizedPnl: dec(0),
    unrealizedPnl: dec(0),
    totalPnl: dec(0),
    positions: [{ asset: 'BTC', qty: dec('0.002'), avgCost: dec(50000), price: dec(50000), priceStale: false, value: dec(100), unrealizedPnl: dec(0), weightPercent: dec(10) }],
  };
  const nothingBooked = { status: 'decided', row: { notification_summary: 'x' }, execution: { bookedLedger: [] }, portfolioAfter: after, provenance: base({}) } as unknown as DecideResult;
  ok('a cycle with nothing booked still sends nothing, provenance or not', prepareActivityNotification(nothingBooked, '2026-09-19T18:00:00Z') === null);
  const booked = {
    status: 'decided',
    row: { notification_summary: 'x' },
    execution: { bookedLedger: [{ symbol: 'BTC/USDT', side: 'buy', valuationPrice: dec(50000), baseDelta: dec('0.002'), quoteDelta: dec('-100.1') }] },
    portfolioAfter: after,
    provenance: base({ target: { BTC: 10, USDT: 90 }, clamped: { BTC: 10, USDT: 90 }, intentReference: { BTC: 0, USDT: 100 }, appliedReference: { BTC: 0, USDT: 100 }, modelLegs: [{ asset: 'BTC', side: 'buy', notional: 100 }] }),
  } as unknown as DecideResult;
  const n = prepareActivityNotification(booked, '2026-09-19T18:00:00Z')!;
  ok('the movements still come from the ledger fact, and the attribution follows them', n.movements[0]!.usd > 100 && n.attribution.movements[0]!.origin === 'modele');
  ok('the resulting allocation and total are unchanged', n.totalUsd === 1000 && n.allocation.at(-1)!.label === 'cash');
  const text = formatActivity(n);
  ok('the layout: header, movements, layers, reasoning, allocation, total', text.startsWith('🤖 Crypto-Buddy a bougé · 18h00\n\nAchat ~100$ de BTC — modèle\n\nModèle : révision BTC 0 → 10 %.\nRaisonnement du modèle : x\n\nAlloc : 10% BTC · 90% cash\nTotal : ~1000$'));
}

console.log(`\n${passed} activity-attribution checks passed.`);
