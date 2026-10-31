import type { RunResult } from '../exposure/engine.js';
import { computeRunMetrics, type RunMetrics } from '../exposure/metrics.js';
import type { CrashEpisode } from './daily.js';
import { REBUY_EXPOSURE_PERCENT } from './parameters.js';

/**
 * WHAT THE EXIT EXPERIMENT PUBLISHES FOR EACH POLICY — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, §10.
 *
 * The v1.3 measures (`computeRunMetrics`: net return, continuous drawdown, turnover, fees and
 * slippage, exposure distribution, calendar years) plus what this protocol adds: the number of
 * exits, the time spent in cash, the per-episode readings and the rebuy delay, and the A1 check —
 * a line the rule holds out must hold nothing once its exit has filled, and any residue is counted
 * here rather than hidden.
 */

const DAY_MS = 86_400_000;

export interface EpisodeReading {
  episode: number;
  startMs: number;
  endMs: number;
  troughMs: number;
  /** Equity at the close of the episode's start, then at its end. */
  startEquity: number;
  endEquity: number;
  returnPercent: number;
  /** Drawdown from the policy's own running high, starting at the episode's start. */
  drawdownWithinPercent: number;
  /** The continuous drawdown (from the whole trajectory's high), its worst inside the episode. */
  continuousDrawdownPercent: number;
  /** Days from the index trough to the first 4h close at >= 80 % realised exposure; null = "non revenu". */
  rebuyDelayDays: number | null;
  rebuyAtMs: number | null;
}

export interface ExitMetrics {
  policy: string;
  base: RunMetrics;
  /** Fees plus slippage, cumulated, in dollars: the §11 friction requirement reads this. */
  frictionUsd: number;
  /** Lines taken out: by the rule (S1-S5) or by the peak stop (E1, TC44). Each line counts once. */
  exits: number;
  /** Daily closes (rule) or 4h bars (stop) on which at least one exit was decided. */
  exitEvents: number;
  /** Lines the rule let back in. */
  ruleEntries: number;
  /** 100 − mean realised exposure. */
  meanCashPercent: number;
  /** Share of 4h closes with less than 1 % realised exposure. */
  fullyOutTimePercent: number;
  /** Share of 4h closes during which the rule holds each asset out. */
  ruleOutTimePercent: Record<string, number>;
  /** A1: 4h closes on which a line the rule holds out still weighs something after its exit filled. */
  residualBarsAfterExit: number;
  maxResidualWeightPercent: number;
  episodes: EpisodeReading[];
}

const closeOf = (t: number, barMs: number): number => t + barMs;

export function episodeReadings(run: RunResult, barMs: number, episodes: readonly CrashEpisode[]): EpisodeReading[] {
  return episodes.map((e, i) => {
    const startBar = run.bars.find((b) => closeOf(b.t, barMs) === e.startMs);
    if (!startBar) throw new Error(`exit metrics: no 4h close at the start of episode ${i + 1}`);
    const inside = run.bars.filter((b) => closeOf(b.t, barMs) > e.startMs && closeOf(b.t, barMs) <= e.endMs);
    const endEquity = inside.length > 0 ? inside[inside.length - 1]!.equity : startBar.equity;
    let high = startBar.equity;
    let within = 0;
    let continuous = startBar.drawdownPercent;
    for (const b of inside) {
      high = Math.max(high, b.equity);
      within = Math.max(within, ((high - b.equity) / high) * 100);
      continuous = Math.max(continuous, b.drawdownPercent);
    }
    const back = run.bars.find((b) => closeOf(b.t, barMs) >= e.troughMs && b.exposurePercent >= REBUY_EXPOSURE_PERCENT);
    return {
      episode: i + 1,
      startMs: e.startMs,
      endMs: e.endMs,
      troughMs: e.troughMs,
      startEquity: startBar.equity,
      endEquity,
      returnPercent: (endEquity / startBar.equity - 1) * 100,
      drawdownWithinPercent: within,
      continuousDrawdownPercent: continuous,
      rebuyDelayDays: back ? (closeOf(back.t, barMs) - e.troughMs) / DAY_MS : null,
      rebuyAtMs: back ? closeOf(back.t, barMs) : null,
    };
  });
}

export function computeExitMetrics(run: RunResult, barMs: number, episodes: readonly CrashEpisode[]): ExitMetrics {
  const base = computeRunMetrics(run, barMs);
  const bars = run.bars;
  const n = bars.length || 1;
  const ruleExits = bars.reduce((s, b) => s + b.ruleExitsDecided.length, 0);
  const stopExits = bars.reduce((s, b) => s + b.stopExitsDecided.length, 0);
  const assets = Object.keys(bars[0]?.weights ?? {});

  // A1. The exit decided at a close fills at the next open: from the close AFTER that fill on, a
  // line still held out must weigh nothing. The bar that decides the exit is exempt — it still
  // holds the line, by construction.
  let residualBars = 0;
  let maxResidual = 0;
  for (let k = 1; k < bars.length; k += 1) {
    const b = bars[k]!;
    const prev = bars[k - 1]!;
    const residue = b.ruleOut
      .filter((a) => prev.ruleOut.includes(a))
      .reduce((s, a) => s + (b.weights[a] ?? 0), 0);
    if (residue > 1e-9) {
      residualBars += 1;
      maxResidual = Math.max(maxResidual, residue);
    }
  }

  return {
    policy: run.policy,
    base,
    frictionUsd: base.feesPaid + base.slippageCost,
    exits: ruleExits + stopExits,
    exitEvents: bars.filter((b) => b.ruleExitsDecided.length > 0 || b.stopExitsDecided.length > 0).length,
    ruleEntries: bars.reduce((s, b) => s + b.ruleEntriesDecided.length, 0),
    meanCashPercent: 100 - base.exposure.mean,
    fullyOutTimePercent: (bars.filter((b) => b.exposurePercent < 1).length / n) * 100,
    ruleOutTimePercent: Object.fromEntries(assets.map((a) => [a, (bars.filter((b) => b.ruleOut.includes(a)).length / n) * 100])),
    residualBarsAfterExit: residualBars,
    maxResidualWeightPercent: maxResidual,
    episodes: episodeReadings(run, barMs, episodes),
  };
}
