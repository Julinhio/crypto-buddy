import { CANDIDATES, type CandidateName } from './rules.js';
import { SELECTION_RULES } from './parameters.js';

/**
 * THE PRE-REGISTERED SELECTION OF §11 — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, applied as written.
 *
 *   1. eliminated: continuous drawdown above 50 %;
 *   2. eliminated: fees plus slippage, cumulated, above half of E1's;
 *   3. among the rest, the best annualised net return — but a candidate less than 3 annualised
 *      points behind it is preferred if it is simpler, in the order S1, S5, S2, S3, S4;
 *   4. none left: nothing goes to validation (A2), and the result is published.
 *
 * "Meilleur rendement net" is compared on the ANNUALISED net return: on one common window the
 * order is the same as on the total net return, and the 3-point margin is stated annualised.
 */

export interface SelectionInput {
  name: CandidateName;
  maxDrawdownPercent: number;
  frictionUsd: number;
  annualisedReturnPercent: number;
}

export interface SelectionLine extends SelectionInput {
  drawdownOk: boolean;
  frictionOk: boolean;
  /** Friction as a share of E1's. */
  frictionShareOfE1: number;
  retained: boolean;
  /** Annualised points behind the best retained candidate; null when not retained. */
  gapToBestPoints: number | null;
}

export interface SelectionResult {
  e1FrictionUsd: number;
  lines: SelectionLine[];
  best: CandidateName | null;
  /** Retained candidates less than the margin behind the best, in simplicity order. */
  withinMargin: CandidateName[];
  selected: CandidateName | null;
  reason: string;
}

export function selectCandidate(inputs: readonly SelectionInput[], e1FrictionUsd: number): SelectionResult {
  const names = inputs.map((i) => i.name).sort().join(',');
  if (names !== [...CANDIDATES].sort().join(',')) throw new Error(`selection: expected exactly S1-S5, got ${names}`);
  if (!(e1FrictionUsd > 0)) throw new Error('selection: E1 friction must be positive');

  const lines: SelectionLine[] = inputs.map((i) => {
    const drawdownOk = i.maxDrawdownPercent <= SELECTION_RULES.maxDrawdownPercent;
    const frictionOk = i.frictionUsd <= SELECTION_RULES.maxFrictionShareOfE1 * e1FrictionUsd;
    return { ...i, drawdownOk, frictionOk, frictionShareOfE1: i.frictionUsd / e1FrictionUsd, retained: drawdownOk && frictionOk, gapToBestPoints: null };
  });
  const retained = lines.filter((l) => l.retained);
  if (retained.length === 0) {
    const why = lines
      .map((l) => `${l.name}: ${[!l.drawdownOk ? `drawdown ${l.maxDrawdownPercent.toFixed(2)} % > 50 %` : null, !l.frictionOk ? `frictions ${(100 * l.frictionShareOfE1).toFixed(1)} % of E1's > 50 %` : null].filter(Boolean).join(', ')}`)
      .join('; ');
    return { e1FrictionUsd, lines, best: null, withinMargin: [], selected: null, reason: `no candidate meets §11 (${why})` };
  }
  const best = retained.reduce((a, b) => (b.annualisedReturnPercent > a.annualisedReturnPercent ? b : a));
  for (const l of retained) l.gapToBestPoints = best.annualisedReturnPercent - l.annualisedReturnPercent;
  const withinMargin = SELECTION_RULES.simplicityOrder.filter((name) => {
    const l = retained.find((r) => r.name === name);
    return l != null && l.gapToBestPoints! < SELECTION_RULES.simplicityMarginPoints;
  });
  const selected = withinMargin[0]!;
  const reason =
    selected === best.name
      ? `${selected}: best annualised net return among the candidates meeting §11, and no simpler one within 3 points`
      : `${selected}: within ${lines.find((l) => l.name === selected)!.gapToBestPoints!.toFixed(2)} annualised points of the best (${best.name}) and simpler`;
  return { e1FrictionUsd, lines, best: best.name, withinMargin: [...withinMargin], selected, reason };
}
