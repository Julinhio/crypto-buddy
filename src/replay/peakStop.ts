import { config } from '../config/index.js';
import type { Candle } from '../market/klines.js';
import { Decimal, dec } from '../money.js';
import type { StickyPoint } from './stickyTransition.js';
import { stickyAt } from './stickyTransition.js';
import type { Cycle, LifecycleSnapshot } from './transitionCycles.js';

/**
 * THE PEAK STOP — the deterministic risk exit that has to exist if the sticky
 * transition is ever adopted, measured here at four candidate thresholds.
 *
 * The need is structural, not decorative. Under the sticky rule an asset can stay
 * non-actionable for a long stretch, and during that stretch NOTHING can reduce the
 * position — the model is not consulted, and the model is the only thing that ever
 * sells. A rule that can freeze a line for two days without a way out is not a
 * safety improvement, it is a different way to lose money.
 *
 * The contract is fixed by the brief and implemented exactly, with no discretion left
 * anywhere:
 *
 *  - it arms ONLY during a sticky transition (a frozen bar). Outside one, the model
 *    still owns the decision and a mechanical stop would be a second, competing brain;
 *  - it reads ONLY the live price and the peak since entry, both owned by the code.
 *    Nothing the model produced is an input, so no prompt change can move it;
 *  - the threshold is CONFIGURATION (see `PEAK_STOP_THRESHOLDS`), never a number the
 *    model picks;
 *  - firing means a FULL, SINGLE exit. A partial reduction repeated every cycle would
 *    liquidate the line in slices — the drip the 2% floor was introduced to end;
 *  - no re-entry until the transition confirms, i.e. until the asset is actionable again;
 *  - price or peak missing or stale → NO ORDER. Never a substitute value. This is the
 *    one branch that must never be "helpful": a stop that invents its own input is a
 *    stop that fires on nothing.
 *
 * ── What this measures, and what it deliberately does not ────────────────────
 *
 * The stop is a SHADOW OVERLAY on the real tape, not a rewrite of it. Each trigger is
 * measured as an episode on the observed price path; the history itself keeps running
 * exactly as it did. That is a limit, and it is the honest one: rewriting the tape
 * would change every later book the model was shown, and the only way to learn what it
 * would then have decided is to re-run it — which this harness refuses to do, for the
 * same reason the regime replay refuses to (a backtest cannot honestly answer "would
 * the model have taken its profits", and 1079 non-deterministic re-runs would be an
 * expensive way to produce a number nobody should trust).
 *
 * So the reported effect is per-episode and position-level, under ONE deterministic
 * counterfactual with no free parameters: sell the whole line at the trigger cycle's
 * price, pay the fee, and buy it back at the first cycle the asset is actionable again,
 * paying the fee a second time. Every real order that would have landed on a line while
 * the shadow held it in cash is counted and reported, so the size of the divergence
 * between the two worlds is a published number rather than a hidden assumption.
 */

/** Quantities at or below this count as flat (mirrors derive.ts / lifecycle.ts). */
const DUST = new Decimal('1e-12');

const HOUR_MS = 3_600_000;

/**
 * The thresholds under test, as percent below the peak.
 *
 * Deliberately declared HERE and not in `src/config/index.ts`: this brief is a
 * measurement and changes no production behaviour, so the live config gains nothing
 * from a knob nothing reads. If the stop is adopted, this is the shape that moves into
 * `RegimeConfig` — a per-asset (or per-volatility-class) record, resolved by the code,
 * never by the model.
 */
export const PEAK_STOP_THRESHOLDS = [5, 8, 10, 12] as const;

/** Why a frozen, drawn-down line was NOT stopped — counted, never silently dropped. */
export interface StopAbstentions {
  /** No regime bar had closed yet for this cycle. */
  noRegime: number;
  /** Price missing or stale — the branch that must never substitute a value. */
  noPrice: number;
  /** No peak on record (a line whose entry cycle had no live price). */
  noPeak: number;
}

export interface StopEpisode {
  asset: string;
  threshold: number;
  exitCycleId: number;
  exitAtMs: number;
  exitPrice: Decimal;
  /** The peak the drawdown was measured against. */
  peak: Decimal;
  /** Drawdown that triggered it, in percent (negative). */
  triggerDrawdownPercent: number;
  /** Quantity sold — the whole line. */
  qty: Decimal;
  /** Notional at the exit price, before fees. */
  notional: Decimal;

  /** The cycle re-entry became possible, or null when it never did inside the window. */
  reentryCycleId: number | null;
  reentryAtMs: number | null;
  reentryPrice: Decimal | null;
  /** Why the episode ended without a re-entry. */
  unresolved: 'still-frozen-at-window-end' | 'line-went-flat-on-the-real-tape' | null;
  /** Hours between the exit and the moment re-entry became possible. */
  hoursOut: number | null;

  /** Lowest traded price between the exit and the re-entry, as % of the exit price. */
  extraDrawdownAvoidedPercent: number | null;
  /** Price 24h / 72h after the exit, as % of the exit price. Null when past the series. */
  rebound24hPercent: number | null;
  rebound72hPercent: number | null;

  /** Both fees (exit + re-entry), in quote. One fee only when there was no re-entry. */
  feesPaid: Decimal;
  /**
   * Value of the line at the re-entry moment, stopped minus held. Positive = the stop
   * paid for itself. Null when the episode never resolved (no honest comparison point).
   */
  netEffect: Decimal | null;

  /** Cycles spent out of the market. */
  cyclesOut: number;
  /** Real bookings on this line while the shadow held cash — the divergence, counted. */
  realOrdersDuringOut: number;
  /** Sum of the exposure NOT carried while out, in quote·cycles — feeds the average. */
  exposureForgone: Decimal;
}

export interface StopRun {
  threshold: number;
  episodes: StopEpisode[];
  abstentions: StopAbstentions;
  /** Asset-cycles the stop was armed on (frozen, holding, priced). */
  armedAssetCycles: number;
}

/**
 * The close of the last candle that had CLOSED at or before `atMs` — or null when the
 * series does not reach that far.
 *
 * The out-of-range guard is the load-bearing half. Without it, walking to the end of the
 * series and keeping the last match silently answers a question about 72 hours from now
 * with a price from three days ago: a feed that stops short would not produce a gap, it
 * would produce a plausible number for the wrong horizon. A missing rebound must read as
 * missing, so the report can exclude it, which is the whole no-synthetic-data rule.
 */
export function closeAt(candles: Candle[], atMs: number, barMs: number): Decimal | null {
  const last = candles[candles.length - 1];
  if (last == null || atMs > last.timestamp + barMs) return null;
  let found: Candle | null = null;
  for (const c of candles) {
    if (c.timestamp + barMs > atMs) break;
    found = c;
  }
  if (found == null) return null;
  // The bar we landed on must be the one that closed MOST RECENTLY before `atMs`, i.e.
  // within one bar of it. A hole in the feed would otherwise hand back a close from the
  // far side of the gap and present it as the price at this horizon — the same silent
  // substitution the range guard above exists to stop, arriving through the middle of
  // the series instead of past its end.
  if (atMs - (found.timestamp + barMs) >= barMs) return null;
  return dec(found.close);
}

/**
 * Lowest traded low over the bars FULLY INSIDE [fromMs, toMs]. Null when the series does
 * not cover the whole interval, or has a hole in it.
 *
 * ── Two properties worth stating plainly, because the report quotes this number ──
 *
 * COVERAGE IS CHECKED AT BOTH ENDS AND IN THE MIDDLE. Guarding only the right end still
 * lets a feed that starts late, or that drops a bar somewhere inside, return a minimum
 * over an unknown subset — the plausible partial-window value this guard exists to
 * reject, reached from a different direction. So: the series must begin at or before
 * `fromMs`, must reach `toMs`, and the bars inside must be consecutive.
 *
 * IT IS A CONSERVATIVE BOUND, and deliberately the conservative one. Episode boundaries
 * are cycle timestamps and do not land on bar boundaries, so a bar straddling the exit
 * or the re-entry is excluded rather than counted: its low may have printed outside the
 * episode, and claiming it would credit the stop with a drawdown it never avoided. The
 * consequence is that the reported avoided drawdown UNDERSTATES the true one by up to
 * one bar at each end — an error that runs against the stop's case, never for it, which
 * is the correct direction for a number used to argue a threshold. The harness feeds
 * this 1h bars rather than the 4h regime bars precisely to shrink that residue.
 */
export function lowestBetween(candles: Candle[], fromMs: number, toMs: number, barMs: number): Decimal | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (first == null || last == null) return null;
  if (first.timestamp > fromMs || toMs > last.timestamp + barMs) return null;

  const inside = candles.filter((c) => c.timestamp >= fromMs && c.timestamp + barMs <= toMs);
  if (inside.length === 0) return null;
  for (let i = 1; i < inside.length; i += 1) {
    if (inside[i]!.timestamp - inside[i - 1]!.timestamp !== barMs) return null;
  }

  let low: Decimal | null = null;
  for (const c of inside) {
    const candidate = dec(c.low);
    if (low == null || candidate.lt(low)) low = candidate;
  }
  return low;
}

const pctOf = (value: Decimal, base: Decimal): number => value.minus(base).div(base).times(100).toNumber();

/**
 * Runs the stop over the whole cycle stream at ONE threshold.
 *
 * `snapshots[i]` is the lifecycle state AFTER cycle i, so the peak a cycle reads is
 * `snapshots[i-1]` ratcheted by that cycle's own price — which is precisely what
 * `toDecisionContext` shows the model, and is verified against the 933 journaled
 * lifecycle views by the harness.
 */
export function runPeakStop(params: {
  threshold: number;
  cycles: Cycle[];
  snapshots: LifecycleSnapshot[];
  sticky: Record<string, StickyPoint[]>;
  /** Fine-grained price series — 1h, NOT the 4h regime bars. See `priceBarMs`. */
  series: Record<string, Candle[]>;
  assets: string[];
  /** The regime bar (4h): decides which sticky bar a cycle reads. */
  barMs: number;
  /**
   * The PRICE series bar. Kept separate from `barMs` on purpose: the regime is a 4h
   * object and must stay one, but the price path around an episode is measured on 1h
   * bars so the unresolvable residue at each boundary is an hour rather than four. Two
   * different questions, two granularities, and conflating them would either coarsen
   * the measurement or silently change what production computes.
   */
  priceBarMs: number;
}): StopRun {
  const { threshold, cycles, snapshots, sticky, series, assets, barMs, priceBarMs } = params;
  const feeRate = dec(config.execution.feePercent).div(100);

  const episodes: StopEpisode[] = [];
  const abstentions: StopAbstentions = { noRegime: 0, noPrice: 0, noPeak: 0 };
  let armedAssetCycles = 0;

  for (const asset of assets) {
    const timeline = sticky[asset] ?? [];
    const candles = series[asset] ?? [];
    let out = false;
    let open: StopEpisode | null = null;
    // The peak of the SHADOW position. Identical to the real one until the first
    // trigger; reset at every exit, and reseeded at the re-entry price, because a full
    // exit ends the line's life (position_state's own rule). Without that reset the
    // shadow would re-enter carrying the old high-water mark and fire again on the very
    // next cycle — liquidating the line in slices, which is what the contract forbids.
    let shadowPeak: Decimal | null = null;

    const closeEpisode = (
      episode: StopEpisode,
      reentry: { cycle: Cycle; price: Decimal } | null,
      unresolved: StopEpisode['unresolved'],
    ): void => {
      if (reentry != null) {
        episode.reentryCycleId = reentry.cycle.id;
        episode.reentryAtMs = reentry.cycle.generatedAtMs;
        episode.reentryPrice = reentry.price;
        episode.hoursOut = (reentry.cycle.generatedAtMs - episode.exitAtMs) / HOUR_MS;
        const proceeds = episode.notional.times(dec(1).minus(feeRate));
        // Two fees: out and back in. The comparison point is the value of the LINE at
        // the moment re-entry became possible — stopped versus never having sold.
        episode.feesPaid = episode.notional.times(feeRate).plus(proceeds.times(feeRate));
        const stoppedValue = proceeds.times(dec(1).minus(feeRate));
        const heldValue = episode.qty.times(reentry.price);
        episode.netEffect = stoppedValue.minus(heldValue);
        episode.extraDrawdownAvoidedPercent = (() => {
          const low = lowestBetween(candles, episode.exitAtMs, reentry.cycle.generatedAtMs, priceBarMs);
          return low == null ? null : pctOf(low, episode.exitPrice);
        })();
      } else {
        episode.unresolved = unresolved;
        episode.feesPaid = episode.notional.times(feeRate);
      }
      episodes.push(episode);
    };

    for (let i = 0; i < cycles.length; i += 1) {
      const cycle = cycles[i]!;
      const view = cycle.assets.get(asset);
      const price = view?.price ?? null;
      const realQty = view?.qtyBefore ?? new Decimal(0);
      const state = stickyAt(timeline, cycle.generatedAtMs, barMs);

      // The real line went flat. Whatever the shadow was doing, there is no position to
      // compare against any more — the episode ends unresolved rather than being scored
      // against a line that no longer exists.
      if (realQty.lte(DUST)) {
        if (open != null) {
          closeEpisode(open, null, 'line-went-flat-on-the-real-tape');
          open = null;
        }
        out = false;
        shadowPeak = null;
        continue;
      }

      if (out) {
        if (open != null) {
          open.cyclesOut += 1;
          open.realOrdersDuringOut += cycle.bookings.filter((b) => b.asset === asset).length;
          if (price != null) open.exposureForgone = open.exposureForgone.plus(open.qty.times(price));
        }
        // "No re-entry until the transition is confirmed" — the asset becoming
        // actionable again IS the confirmation, and the same rule decides both.
        if (state?.actionable === true && price != null && open != null) {
          closeEpisode(open, { cycle, price }, null);
          open = null;
          out = false;
          shadowPeak = price;
        }
        continue;
      }

      // Holding. Ratchet the shadow peak on the real price, seeding it from the
      // replayed lifecycle peak the first time (so a line already deep into its life
      // does not restart its high-water mark at the window's first bar).
      const replayedPeak = i > 0 ? (snapshots[i - 1]!.states.get(asset)?.peakPriceSinceEntry ?? null) : null;
      if (shadowPeak == null) shadowPeak = replayedPeak ?? price;
      else if (price != null) shadowPeak = Decimal.max(shadowPeak, price);

      if (state == null) {
        abstentions.noRegime += 1;
        continue;
      }
      // Armed ONLY during a sticky transition. Outside one the model still owns the line.
      if (!state.frozen) continue;

      if (price == null) {
        abstentions.noPrice += 1;
        continue;
      }
      if (shadowPeak == null || shadowPeak.lte(0)) {
        abstentions.noPeak += 1;
        continue;
      }

      armedAssetCycles += 1;
      const drawdown = pctOf(price, shadowPeak);
      if (drawdown > -threshold) continue;

      const notional = realQty.times(price);
      open = {
        asset,
        threshold,
        exitCycleId: cycle.id,
        exitAtMs: cycle.generatedAtMs,
        exitPrice: price,
        peak: shadowPeak,
        triggerDrawdownPercent: drawdown,
        qty: realQty,
        notional,
        reentryCycleId: null,
        reentryAtMs: null,
        reentryPrice: null,
        unresolved: null,
        hoursOut: null,
        extraDrawdownAvoidedPercent: null,
        rebound24hPercent: (() => {
          const p = closeAt(candles, cycle.generatedAtMs + 24 * HOUR_MS, priceBarMs);
          return p == null ? null : pctOf(p, price);
        })(),
        rebound72hPercent: (() => {
          const p = closeAt(candles, cycle.generatedAtMs + 72 * HOUR_MS, priceBarMs);
          return p == null ? null : pctOf(p, price);
        })(),
        feesPaid: new Decimal(0),
        netEffect: null,
        cyclesOut: 0,
        realOrdersDuringOut: 0,
        exposureForgone: new Decimal(0),
      };
      out = true;
      shadowPeak = null;
    }

    if (open != null) closeEpisode(open, null, 'still-frozen-at-window-end');
  }

  return { threshold, episodes: episodes.sort((a, b) => a.exitAtMs - b.exitAtMs), abstentions, armedAssetCycles };
}
