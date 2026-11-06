/**
 * THE PARAMETERS OF THE EXIT EXPERIMENT — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, §8 and A3.
 *
 * Frozen as written, with no search grid: 97 / 103 % around the 200-day mean, a 20 % trailing stop
 * on daily closes, the 50-day mean for its rebuy, 10 days out at least for S4. Every module of the
 * experiment reads them from here, and the freeze signs this object.
 */
export const EXIT_PARAMETERS = Object.freeze({
  /** S1, S2, S5: the long mean, in daily closes. */
  longMeanDays: 200,
  /** S3, S4: the mean whose re-crossing rebuys, in daily closes. */
  shortMeanDays: 50,
  /** S2, S5: out below this fraction of the long mean. */
  hysteresisExitRatio: 0.97,
  /** S2, S5: back in only above this fraction of the long mean. */
  hysteresisEntryRatio: 1.03,
  /** S3, S4: out at this percent under the highest daily close since the entry was filled. */
  trailingStopPercent: 20,
  /** S4: days out of the market, at least, before any rebuy. */
  minDaysOut: 10,
});

/** §9: a crash episode is a fall of the synthetic index of at least this much from its rolling high. */
export const CRASH_THRESHOLD_PERCENT = 30;

/** §10: the realised exposure that counts as "back in" for the rebuy delay. */
export const REBUY_EXPOSURE_PERCENT = 80;

/** §11 and §12. */
export const SELECTION_RULES = Object.freeze({
  maxDrawdownPercent: 50,
  /** Fees plus slippage, cumulated, at most this fraction of E1's. */
  maxFrictionShareOfE1: 0.5,
  /** Below this gap in annualised net return, the simpler candidate is preferred. */
  simplicityMarginPoints: 3,
  /** From the simplest to the most complex. */
  simplicityOrder: Object.freeze(['S1', 'S5', 'S2', 'S3', 'S4'] as const),
});
