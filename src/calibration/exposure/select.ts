import type { BandPolicy } from './controller.js';
import type { FreezeMode } from './engine.js';
import { runPolicy, searchConstantWitness, type SharedTape, type WindowBounds } from './arms.js';
import type { Metrics } from './metrics.js';
import type { ValidableConfiguration } from './validate.js';

/**
 * STEPS 3 TO 7 — the RSI candidate, the freeze asymmetry, and the frozen witnesses.
 *
 * The ORDER is the protocol's, and it is the only thing separating this from a search over
 * every combination until one looks good. Each step is allowed to look at strictly less than
 * the previous one:
 *
 *   3. the RSI is tested on the SELECTED arm only — never on all three;
 *   4. its verdict is frozen, in or out, and never revisited;
 *   5. the asymmetry is tested on THAT configuration only;
 *   6. if it passes, BOTH variants are pre-registered for the single OOS opening;
 *   7. every validable configuration gets its OWN witness, searched then frozen.
 *
 * Every criterion below was written before any result was looked at.
 */

/** RSI branch 1: a real return gain that does not cost much drawdown. */
export const RSI_BRANCH_A = { minCagrGainPoints: 1.5, maxDrawdownDegradationPoints: 2 };
/** RSI branch 2: a real drawdown reduction that does not cost much return. */
export const RSI_BRANCH_B = { minDrawdownGainPoints: 3, maxCagrDegradationPoints: 1 };

/** Asymmetry, calibration half. The OOS half is judged in the sealed window. */
export const ASYMMETRY_MIN_CAGR_GAIN_POINTS = 1;
export const ASYMMETRY_MAX_DRAWDOWN_DEGRADATION_POINTS = 2;

export interface VariantComparison {
  baseline: Metrics;
  variant: Metrics;
  cagrDeltaPoints: number;
  /** POSITIVE means the variant's drawdown got WORSE. */
  drawdownDeltaPoints: number;
}

export function compareVariant(baseline: Metrics, variant: Metrics): VariantComparison {
  return {
    baseline,
    variant,
    cagrDeltaPoints: variant.cagrPercent - baseline.cagrPercent,
    drawdownDeltaPoints: variant.maxDrawdownPercent - baseline.maxDrawdownPercent,
  };
}

export interface RsiVerdict extends VariantComparison {
  branchA: boolean;
  branchB: boolean;
  retained: boolean;
  reason: string;
}

/**
 * STEP 3 — the RSI candidate, on the selected arm, at IDENTICAL band.
 *
 * Two branches, either of which suffices, each cumulative in itself. They encode two
 * different reasons to want the brake: it made more money without costing much safety, or it
 * bought real safety without costing much money. Anything else is not worth a permanent extra
 * input in the controller.
 *
 * This is the ONLY candidate input. No other will be tested after the results are read — that
 * restriction is what stops the "one more idea" loop that turns a calibration into a fit.
 */
export function judgeRsi(baseline: Metrics, withRsi: Metrics): RsiVerdict {
  const cmp = compareVariant(baseline, withRsi);
  const branchA =
    cmp.cagrDeltaPoints >= RSI_BRANCH_A.minCagrGainPoints &&
    cmp.drawdownDeltaPoints < RSI_BRANCH_A.maxDrawdownDegradationPoints;
  const branchB =
    -cmp.drawdownDeltaPoints >= RSI_BRANCH_B.minDrawdownGainPoints &&
    -cmp.cagrDeltaPoints < RSI_BRANCH_B.maxCagrDegradationPoints;

  const retained = branchA || branchB;
  const reason = retained
    ? branchA
      ? `branch A: CAGR ${cmp.cagrDeltaPoints >= 0 ? '+' : ''}${cmp.cagrDeltaPoints.toFixed(2)}pt with drawdown ` +
        `${cmp.drawdownDeltaPoints >= 0 ? '+' : ''}${cmp.drawdownDeltaPoints.toFixed(2)}pt`
      : `branch B: drawdown ${cmp.drawdownDeltaPoints.toFixed(2)}pt with CAGR ` +
        `${cmp.cagrDeltaPoints >= 0 ? '+' : ''}${cmp.cagrDeltaPoints.toFixed(2)}pt`
    : `neither branch: CAGR ${cmp.cagrDeltaPoints >= 0 ? '+' : ''}${cmp.cagrDeltaPoints.toFixed(2)}pt ` +
      `(needs +${RSI_BRANCH_A.minCagrGainPoints}), drawdown ${cmp.drawdownDeltaPoints >= 0 ? '+' : ''}` +
      `${cmp.drawdownDeltaPoints.toFixed(2)}pt (needs −${RSI_BRANCH_B.minDrawdownGainPoints})`;

  return { ...cmp, branchA, branchB, retained, reason };
}

export interface AsymmetryVerdict extends VariantComparison {
  cagrOk: boolean;
  drawdownOk: boolean;
  admissible: boolean;
  reason: string;
}

/**
 * STEP 5 — the freeze asymmetry, on the frozen configuration only.
 *
 * Two runs identical in every respect but one: the full gate against a SELL-ONLY freeze,
 * where a frozen line may be reinforced but not reduced. The deterministic stop and the
 * reduction under `risk_off` are unchanged in both — so what is being compared is the freeze,
 * not the ladder.
 *
 * Only the two CALIBRATION conditions are judged here. The third — out-of-sample net return
 * at least equal to the symmetric variant — belongs to the sealed window, and judging it here
 * would mean opening that window early.
 */
export function judgeAsymmetry(symmetric: Metrics, asymmetric: Metrics): AsymmetryVerdict {
  const cmp = compareVariant(symmetric, asymmetric);
  const cagrOk = cmp.cagrDeltaPoints >= ASYMMETRY_MIN_CAGR_GAIN_POINTS;
  const drawdownOk = cmp.drawdownDeltaPoints < ASYMMETRY_MAX_DRAWDOWN_DEGRADATION_POINTS;
  const admissible = cagrOk && drawdownOk;
  return {
    ...cmp,
    cagrOk,
    drawdownOk,
    admissible,
    reason: admissible
      ? `CAGR +${cmp.cagrDeltaPoints.toFixed(2)}pt with drawdown ${cmp.drawdownDeltaPoints >= 0 ? '+' : ''}` +
        `${cmp.drawdownDeltaPoints.toFixed(2)}pt — admissible to validation, where the OOS condition still applies`
      : `not admissible: CAGR ${cmp.cagrDeltaPoints >= 0 ? '+' : ''}${cmp.cagrDeltaPoints.toFixed(2)}pt ` +
        `(needs +${ASYMMETRY_MIN_CAGR_GAIN_POINTS}), drawdown ${cmp.drawdownDeltaPoints >= 0 ? '+' : ''}` +
        `${cmp.drawdownDeltaPoints.toFixed(2)}pt (needs < +${ASYMMETRY_MAX_DRAWDOWN_DEGRADATION_POINTS})`,
  };
}

/**
 * STEP 7 — one searched, frozen witness per validable configuration.
 *
 * NOT one per arm. The RSI and the asymmetry both move realised mean exposure, so a witness
 * inherited from the bare arm would no longer be matched — and an unmatched witness stops
 * controlling for beta, which is the only reason the comparison means anything. Each variant
 * is therefore re-searched against ITS OWN realised exposure, and the answer is frozen into
 * the selection file before the sealed window is opened. It is never recomputed on the
 * out-of-sample mean.
 */
export function freezeWitness(
  shared: SharedTape,
  window: WindowBounds,
  name: string,
  bands: BandPolicy,
  rsi: boolean,
  freeze: FreezeMode,
): { configuration: ValidableConfiguration; metrics: Metrics; witnessMetrics: Metrics } {
  const { metrics } = runPolicy(shared, { kind: 'band', bands, rsiBrake: rsi, freeze }, window);
  // The witness inherits the FREEZE variant (mechanics) and never the RSI brake (treatment).
  const witness = searchConstantWitness(shared, window, metrics.meanExposurePercent, freeze);
  const { metrics: witnessMetrics } = runPolicy(
    shared,
    { kind: 'constant', targetPercent: witness.targetPercent, freeze },
    window,
  );
  return {
    configuration: {
      name,
      bands,
      rsi,
      freeze,
      witnessTargetPercent: witness.targetPercent,
      witnessMismatchPoints: witness.mismatchPoints,
    },
    metrics,
    witnessMetrics,
  };
}
