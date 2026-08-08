import { config, tradableBaseAssets } from '../config/index.js';
import { publicMainnetClient } from '../exchanges/binance.js';
import type { Candle } from '../market/klines.js';
import { timeframeMs } from '../market/klines.js';
import { regimeTimeline } from '../market/regime.js';
import { stickyTimelines, type StickyPoint } from '../market/transition.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { fetchCandlesSince } from './klines.js';
import { loadCycleStream, replayPeaks, type Booking, type Cycle, type LifecycleSnapshot } from './transitionCycles.js';
import { loadObservationWindow, replayRegimeOptions, type ReplayWindow } from './window.js';

/**
 * THE TAPE every transition harness replays — loaded once, in one way.
 *
 * Two harnesses now read it: the layer proof (`transitionLayerProof.ts`), which asks
 * whether the live gate computes what the measurement measured, and the risk_off
 * counterfactual (`riskOffCounterfactual.ts`), which exercises the one rung of the ladder
 * the real data never has.
 *
 * They MUST see the same bars, the same cycles and the same peaks. A counterfactual built
 * on a tape assembled even slightly differently would be answering a question about its
 * own reconstruction — and the whole point of it is to say something about the ladder that
 * production runs. So the assembly lives here rather than being written twice.
 *
 * READ-ONLY, and bounded: the observation window is captured at the start of the run and
 * everything below is clipped to it, because the bot keeps writing while this executes.
 */

export interface TransitionTape {
  window: ReplayWindow;
  /** Sticky walk per asset, warm-up prefix kept, capped at the window's end. */
  sticky: Record<string, StickyPoint[]>;
  /** 4h candles per asset, for anything that needs the price path. */
  h4: Record<string, Candle[]>;
  cycles: Cycle[];
  bookings: Booking[];
  /** Lifecycle state after each cycle, index-aligned with `cycles`. */
  snapshots: LifecycleSnapshot[];
  /** Tradable assets that actually produced a sticky walk. */
  tradable: string[];
  /** Rows the live bot committed after the window was captured, and therefore excluded. */
  arrivedDuringTheRun: number;
  barMs: number;
  confirmations: number;
}

/**
 * Loads the tape for an ALREADY CAPTURED window.
 *
 * The window is taken as a parameter rather than read here so each harness can print its
 * own header — which quotes the window — before the slow part starts, exactly where it
 * printed it before. `label` only prefixes the progress line.
 */
export async function loadTransitionTape(window: ReplayWindow, label: string): Promise<TransitionTape> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error(
      `${label}: Supabase is not configured — the harness reads (read-only) the decisions and ` +
        'executions journals. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  const barMs = timeframeMs(config.regime.timeframe);
  const confirmations = config.regime.thresholds.confirmations;

  // Candles, with enough history before the window for the indicators and the sticky walk
  // to have converged well before the first measured bar.
  const client = publicMainnetClient();
  const DAY_MS = 24 * 3_600_000;
  const universe: Record<string, { daily: Candle[]; h4: Candle[] }> = {};
  for (const symbol of [...config.tradablePairs, ...config.referencePairs]) {
    const base = symbol.split('/')[0];
    if (!base) continue;
    const [daily, h4] = await Promise.all([
      fetchCandlesSince(client, symbol, config.primaryTimeframe, window.fromMs - 260 * DAY_MS),
      fetchCandlesSince(client, symbol, config.regime.timeframe, window.fromMs - 60 * DAY_MS),
    ]);
    universe[base] = { daily, h4 };
  }

  const timeline = regimeTimeline(universe, config.regime.thresholds, replayRegimeOptions());
  // Capped at the observation window, warm-up prefix kept: the same two-sided discipline
  // the measurement harness uses. Past the cap we would be resolving cycles with bars the
  // bot never saw; without the prefix the earliest cycles would resolve to nothing.
  const analysed = timeline.filter((p) => p.timestamp + barMs <= window.toMs);
  const sticky = stickyTimelines(analysed, confirmations, barMs);

  const { cycles, bookings, arrivedDuringTheRun } = await loadCycleStream(supabase, window.toMs);
  const { snapshots } = replayPeaks(cycles);
  console.log(
    `${label} ${cycles.length} cycles, ${bookings.length} sovereign bookings, ` +
      `${arrivedDuringTheRun} row(s) committed by the live bot after the window was captured (excluded).`,
  );

  const h4: Record<string, Candle[]> = {};
  for (const [asset, series] of Object.entries(universe)) h4[asset] = series.h4;

  return {
    window,
    sticky,
    h4,
    cycles,
    bookings,
    snapshots,
    tradable: tradableBaseAssets(config).filter((a) => sticky[a] != null),
    arrivedDuringTheRun,
    barMs,
    confirmations,
  };
}
