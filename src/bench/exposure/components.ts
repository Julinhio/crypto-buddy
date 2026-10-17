import { netBreadth } from '../../calibration/exposure/controller.js';
import type { BenchCandle } from './bundle.js';
import type { Tape } from './tape.js';

/**
 * THE CANDIDATE COMPONENTS OF SCORE — computed from the bundle alone, causally.
 *
 * Protocol v1.3, point 5: the signal is known at the CLOSE. Here "known" has one meaning,
 * written once: at the decision instant `D = t + bar` (the close of the 4h bar opened at `t`),
 * a daily candle is usable when it has closed by then, `timestamp + 1 day ≤ D`. Everything a
 * component reads is either a field of production's regime point at `t` (already causal,
 * production's own rule) or a daily candle that passes that test. Nothing is centred,
 * normalised or ranked over a window here: normalisation is a fit, it belongs to `score.ts`,
 * and it is learned on the development window only.
 *
 * AGGREGATION. SCORE sizes a TOTAL exposure on a fixed basket, so its components are read at
 * the basket's level: per-asset quantities are combined with the basket weights, never
 * tested one asset at a time (audit 17/10, point 3).
 *
 * WHAT IS NOT HERE, AND WHY (protocol v1.3, point 3; audit, point 3): funding, open interest,
 * on-chain, dominance, sentiment, macro, order book — absent from the bundle; distance to the
 * all-time high — the bundle starts in 2020, after the 2017-2018 highs, so it would be a
 * different variable from production's; anything the model produces.
 */

export const COMPONENT_NAMES = [
  'breadth_net',
  'risk_off',
  'trend_sma50',
  'trend_sma200',
  'mom_30d',
  'mom_90d',
  'mom_180d',
  'vol_30d',
  'drawdown_365d',
  'rsi_median_4h',
  'rsi_daily',
  'range_position_30d',
  'volume_ratio_30_180',
  'taker_buy_7d',
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];
export type ComponentVector = Record<ComponentName, number | null>;

/** One line of documentation per component, published with the study. */
export const COMPONENT_DEFINITIONS: Readonly<Record<ComponentName, string>> = Object.freeze({
  breadth_net: "production's net directional breadth on the four tradables, confirmed regimes, in [-1, 1]",
  risk_off: "production's confirmed global risk_off (1) or not (0), five-asset breadth",
  trend_sma50: 'Σ w·log(close / SMA50), daily',
  trend_sma200: 'Σ w·log(close / SMA200), daily',
  mom_30d: 'Σ w·log(close / close 30 days earlier), daily',
  mom_90d: 'Σ w·log(close / close 90 days earlier), daily',
  mom_180d: 'Σ w·log(close / close 180 days earlier), daily',
  vol_30d: 'annualised standard deviation of the daily basket log return over 30 days',
  drawdown_365d: 'log of the basket index over its 365-day high (≤ 0)',
  rsi_median_4h: "production's median 4h RSI over the five regime assets",
  rsi_daily: 'Σ w·RSI14 daily (production signal)',
  range_position_30d: 'Σ w·position in the 30-day range (production signal), in [0, 1]',
  volume_ratio_30_180: 'log(mean quote volume 30 d / mean quote volume 180 d), four tradables summed',
  taker_buy_7d: 'Σ taker buy quote / Σ quote volume over 7 days, four tradables, minus 0.5',
});

const DAY_MS = 86_400_000;

function sma(values: readonly number[], end: number, n: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i += 1) s += values[i]!;
  return s / n;
}

/** Index of the last daily candle closed by `decisionMs`, or −1. Monotone cursor helper. */
function advance(daily: readonly BenchCandle[], cursor: number, decisionMs: number): number {
  let c = cursor;
  while (c + 1 < daily.length && daily[c + 1]!.timestamp + DAY_MS <= decisionMs) c += 1;
  return c;
}

/**
 * The components at every point of the tape's grid, keyed by the 4h bar's OPEN time `t`
 * (decision at its close). Pure over the tape.
 */
export function computeComponents(
  tape: Tape,
  basket: Readonly<Record<string, number>>,
): Map<number, ComponentVector> {
  const assets = [...tape.tradable];
  const w = (a: string): number => (basket[a] ?? 0) / 100;
  const daily: Record<string, BenchCandle[]> = {};
  const closes: Record<string, number[]> = {};
  const dayIndex: Record<string, Map<number, number>> = {};
  for (const a of assets) {
    daily[a] = tape.tapes[a]!.daily;
    closes[a] = daily[a]!.map((c) => c.close);
    dayIndex[a] = new Map(daily[a]!.map((c, i) => [c.timestamp, i]));
  }

  // The basket index on the days ALL four tradables have a closed daily candle, rebalanced
  // daily to the basket weights: log return_d = log Σ w·P_d / P_{d−1}.
  const commonDays = daily[assets[0]!]!.map((c) => c.timestamp).filter((ts) => assets.every((a) => dayIndex[a]!.has(ts)));
  const basketLog: number[] = [0];
  for (let d = 1; d < commonDays.length; d += 1) {
    let gross = 0;
    for (const a of assets) {
      const i = dayIndex[a]!.get(commonDays[d]!)!;
      const j = dayIndex[a]!.get(commonDays[d - 1]!)!;
      gross += w(a) * (closes[a]![i]! / closes[a]![j]!);
    }
    basketLog.push(basketLog[d - 1]! + Math.log(gross));
  }
  const basketPos = new Map(commonDays.map((ts, i) => [ts, i]));

  const out = new Map<number, ComponentVector>();
  const cursors: Record<string, number> = Object.fromEntries(assets.map((a) => [a, -1]));

  for (const point of tape.points) {
    const decisionMs = point.timestamp + tape.barMs;
    for (const a of assets) cursors[a] = advance(daily[a]!, cursors[a]!, decisionMs);

    const allHave = (n: number): boolean => assets.every((a) => cursors[a]! + 1 >= n);
    const weighted = (f: (a: string, i: number) => number | null): number | null => {
      let s = 0;
      for (const a of assets) {
        const v = f(a, cursors[a]!);
        if (v == null || !Number.isFinite(v)) return null;
        s += w(a) * v;
      }
      return s;
    };
    const momentum = (n: number): number | null =>
      allHave(n + 1) ? weighted((a, i) => Math.log(closes[a]![i]! / closes[a]![i - n]!)) : null;
    const trend = (n: number): number | null =>
      weighted((a, i) => {
        const m = sma(closes[a]!, i, n);
        return m == null ? null : Math.log(closes[a]![i]! / m);
      });

    // Basket-index quantities at the last COMMON closed day.
    const lastCommon = Math.min(...assets.map((a) => (cursors[a]! >= 0 ? daily[a]![cursors[a]!]!.timestamp : -Infinity)));
    const bi = basketPos.get(lastCommon);
    let vol30: number | null = null;
    let dd365: number | null = null;
    if (bi != null && bi >= 30) {
      const rets: number[] = [];
      for (let d = bi - 29; d <= bi; d += 1) rets.push(basketLog[d]! - basketLog[d - 1]!);
      const m = rets.reduce((s, v) => s + v, 0) / rets.length;
      const v = rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1);
      vol30 = Math.sqrt(v) * Math.sqrt(365);
    }
    if (bi != null && bi >= 364) {
      let high = -Infinity;
      for (let d = bi - 364; d <= bi; d += 1) high = Math.max(high, basketLog[d]!);
      dd365 = basketLog[bi]! - high;
    }

    // Flow: sums over the last n closed days of the four tradables.
    const flowSum = (n: number, field: 'quoteVolume' | 'takerBuyQuote'): number | null => {
      if (!allHave(n)) return null;
      let s = 0;
      for (const a of assets) for (let i = cursors[a]! - n + 1; i <= cursors[a]!; i += 1) s += daily[a]![i]![field];
      return s;
    };
    const qv30 = flowSum(30, 'quoteVolume');
    const qv180 = flowSum(180, 'quoteVolume');
    const qv7 = flowSum(7, 'quoteVolume');
    const tb7 = flowSum(7, 'takerBuyQuote');

    const regimeWeighted = (pick: (a: string) => number | null | undefined): number | null => {
      let s = 0;
      for (const a of assets) {
        const v = pick(a);
        if (v == null || !Number.isFinite(v)) return null;
        s += w(a) * v;
      }
      return s;
    };

    out.set(point.timestamp, {
      breadth_net: netBreadth(point, assets).netBreadth,
      risk_off: point.global.riskOff ? 1 : 0,
      trend_sma50: trend(50),
      trend_sma200: trend(200),
      mom_30d: momentum(30),
      mom_90d: momentum(90),
      mom_180d: momentum(180),
      vol_30d: vol30,
      drawdown_365d: dd365,
      rsi_median_4h: point.global.medianH4Rsi,
      rsi_daily: regimeWeighted((a) => point.assets[a]?.signals.rsi14Daily),
      range_position_30d: regimeWeighted((a) => point.assets[a]?.signals.rangePosition),
      volume_ratio_30_180: qv30 != null && qv180 != null && qv180 > 0 ? Math.log((qv30 / 30) / (qv180 / 180)) : null,
      taker_buy_7d: qv7 != null && tb7 != null && qv7 > 0 ? tb7 / qv7 - 0.5 : null,
    });
  }
  return out;
}
