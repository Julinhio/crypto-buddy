import type { AssetRegime, RegimePoint } from '../../market/regime.js';

/**
 * THE CONTEXT CONTROLLER — the thing this whole harness exists to calibrate.
 *
 * The bot sat near 79 % cash for weeks and returned about +2.9 % over v5 where simply
 * holding the launch portfolio would have returned +7.9 %. Neither the caps nor the cash
 * floor caused that: both allow far more exposure than the bot ever used. What is missing
 * is an EXPOSURE OBJECTIVE — a floor and a ceiling that follow the market's context, so a
 * position is sized against a coherent whole instead of being judged as an isolated
 * tactical slice.
 *
 * This module maps context to one of three states. It decides nothing about allocation;
 * that is `allocate.ts`. Keeping the two apart is what makes the state machine testable
 * without a portfolio, and the allocation testable without a market.
 *
 * IT READS PRODUCTION'S OWN REGIMES. `riskOff` and the confirmed per-asset regimes are
 * computed by `market/regime.ts`, imported, never reimplemented — so a calibration that
 * disagreed with production would be a bug here, not a difference of opinion.
 */

export type ContextState = 'defensive' | 'neutral' | 'constructive';

/**
 * The directional classes. `range` is neutral and counts in neither direction.
 *
 * EVERY regime the production enum can produce is listed. That is deliberate: a regime this
 * table does not know must FAIL THE RUN rather than fall through to a default. A silent
 * default is how a new regime would get silently classified as neutral for months, moving
 * every band boundary by a fraction nobody could see.
 */
const BULLISH: ReadonlySet<AssetRegime> = new Set<AssetRegime>(['trend_up', 'reversal_up']);
const BEARISH: ReadonlySet<AssetRegime> = new Set<AssetRegime>(['trend_down', 'reversal_down']);
const NEUTRAL: ReadonlySet<AssetRegime> = new Set<AssetRegime>(['range']);

export class UnknownRegimeError extends Error {
  constructor(regime: string, asset: string) {
    super(
      `exposure controller: regime "${regime}" on ${asset} is not classified as bullish, bearish ` +
        'or neutral. The controller refuses to guess — add it to the table deliberately.',
    );
    this.name = 'UnknownRegimeError';
  }
}

/** Where the controller's two inputs come from, and what it decided. */
export interface ControllerReading {
  state: ContextState;
  /** True when production's global override is active. Beats everything else. */
  riskOff: boolean;
  /** `(bullish − bearish) / assets`, on CONFIRMED regimes. In [-1, 1]. */
  netBreadth: number;
  bullish: number;
  bearish: number;
  neutral: number;
  /** Assets with no usable confirmed regime this bar — counted, never guessed at. */
  unavailable: number;
}

/**
 * NET DIRECTIONAL BREADTH, on the CONFIRMED regimes.
 *
 *   (bullish − bearish) / assetCount
 *
 * The denominator is the CONFIGURED universe, not the assets that happened to produce a
 * regime this bar. Dividing by what loaded would silently rescale the signal during a
 * partial outage — three assets loading, two bullish, would read +0.67 instead of +0.5 and
 * push the controller into `constructive` on thinner evidence than the band was calibrated
 * for. Production's `GlobalPosture` makes exactly the same choice, for exactly this reason.
 *
 * Confirmed, never raw: the raw label flips on a single bar, and calibrating a band against
 * a signal that flickers would measure the flicker.
 */
export function netBreadth(
  point: RegimePoint,
  assets: readonly string[],
): Omit<ControllerReading, 'state' | 'riskOff'> {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let unavailable = 0;

  for (const asset of assets) {
    const entry = point.assets[asset];
    // The asset produced no point at all this bar — it did not load. It has no opinion, so
    // it contributes zero to the numerator while still counting in the denominator. That is
    // NOT the same as being neutral, and it is reported separately so a thin bar is visible
    // in the output rather than passing for a balanced one.
    //
    // (`AssetRegimePoint.regime` is non-nullable once the point exists: production's
    // hysteresis always carries an active label, seeded on the first bar. So "unavailable"
    // means absent, never unconfirmed.)
    if (!entry) {
      unavailable += 1;
      continue;
    }
    const regime = entry.regime;
    if (BULLISH.has(regime)) bullish += 1;
    else if (BEARISH.has(regime)) bearish += 1;
    else if (NEUTRAL.has(regime)) neutral += 1;
    else throw new UnknownRegimeError(regime, asset);
  }

  return {
    netBreadth: (bullish - bearish) / assets.length,
    bullish,
    bearish,
    neutral,
    unavailable,
  };
}

/**
 * The three states, in priority order.
 *
 *   defensive     riskOff — the global override, which supersedes every per-asset regime
 *   neutral       not riskOff, net breadth ≤ 0
 *   constructive  not riskOff, net breadth > 0
 *
 * `riskOff` first and unconditionally: production already treats it as an override, and a
 * controller that let a bullish majority outvote it would be a different risk posture than
 * the one the bot runs. The boundary at exactly zero belongs to `neutral` — a market with
 * as many fallers as risers is not an invitation to lean in.
 */
export function readContext(point: RegimePoint, assets: readonly string[]): ControllerReading {
  const breadth = netBreadth(point, assets);
  const riskOff = point.global.riskOff;
  const state: ContextState = riskOff
    ? 'defensive'
    : breadth.netBreadth > 0
      ? 'constructive'
      : 'neutral';
  return { state, riskOff, ...breadth };
}

/** An exposure band, in percent of equity. Both bounds inclusive. */
export interface Band {
  readonly lowPercent: number;
  readonly highPercent: number;
}

/** One arm: a band per context state. */
export interface BandPolicy {
  readonly defensive: Band;
  readonly neutral: Band;
  readonly constructive: Band;
}

export function bandFor(policy: BandPolicy, state: ContextState): Band {
  return policy[state];
}

/**
 * PROJECTION OF LEAST CHANGE onto the band.
 *
 * Inside the band, do nothing — that is the whole point of a band rather than a target. Not
 * a midpoint: pulling to the middle would generate turnover on every bar that drifted, pay
 * fees for it, and measure the cost of churn instead of the value of the objective.
 *
 * Below, project onto the low bound; above, onto the high bound. The smallest move that
 * satisfies the constraint.
 */
export function projectOntoBand(currentPercent: number, band: Band): number {
  if (currentPercent < band.lowPercent) return band.lowPercent;
  if (currentPercent > band.highPercent) return band.highPercent;
  return currentPercent;
}

/** Fails loudly on a band that could never behave. Bounded at construction, like everything. */
export function validateBandPolicy(name: string, policy: BandPolicy): void {
  const problems: string[] = [];
  for (const state of ['defensive', 'neutral', 'constructive'] as const) {
    const band = policy[state];
    for (const [label, value] of [
      ['lowPercent', band.lowPercent],
      ['highPercent', band.highPercent],
    ] as const) {
      if (!(Number.isFinite(value) && value >= 0 && value <= 100)) {
        problems.push(`${state}.${label} must be in [0, 100] (got ${value})`);
      }
    }
    if (band.lowPercent > band.highPercent) {
      problems.push(`${state}: low (${band.lowPercent}) must not exceed high (${band.highPercent})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid band policy "${name}": ${problems.join('; ')}`);
  }
}
