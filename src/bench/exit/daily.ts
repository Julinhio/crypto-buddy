import { config as productionConfig } from '../../config/index.js';
import type { Tape } from '../exposure/tape.js';
import { CRASH_THRESHOLD_PERCENT, EXIT_PARAMETERS } from './parameters.js';

/**
 * THE DAILY LAYER OF THE EXIT EXPERIMENT — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, §4, §6, §8, §9.
 *
 * Everything the candidate rules read lives here, computed once from the certified daily candles
 * the shared tape already carries: each tradable asset's daily close, its 50- and 200-day simple
 * means, and the synthetic basket index of S5 with its own 200-day mean. Nothing here reads a 4h
 * bar, a regime or a position: the rules are daily, and the tape's 4h machinery is the engine's.
 *
 * ── ONE ROW PER DAILY CLOSE, KEYED BY THE INSTANT IT CLOSED ──────────────────────────
 *
 * A daily candle opened at `T` is known at `T + 24 h` — never before (§4: no decision on a candle
 * that has not closed). Rows are therefore keyed by the CLOSE instant, which is also the open of
 * the 4h bar on which a decision taken at that close executes. A mean "at a close" includes that
 * close: the 200-day mean at the close of day `d` is the mean of the closes of days `d − 199 … d`.
 *
 * ── THE SYNTHETIC INDEX (§8, S5; §9) ─────────────────────────────────────────────────
 *
 * Rebalanced daily to 32.5 / 32.5 / 20 / 15, from close-to-close returns:
 *
 *     I(d) = I(d − 1) × Σ_a w_a × close_a(d) / close_a(d − 1),   I(first) = 100.
 *
 * It is a measuring stick, not a portfolio: no fee, no cap, no gate. The crash episodes of §9 are
 * read on it, and so is S5's filter.
 */

const DAY_MS = 86_400_000;

export interface DailyRow {
  /** The instant the daily candles closed (= their open + 24 h). */
  closeMs: number;
  close: Record<string, number>;
  /** Simple mean of the last 50 closes, this one included. Null before 50 closes. */
  sma50: Record<string, number | null>;
  /** Simple mean of the last 200 closes, this one included. Null before 200 closes. */
  sma200: Record<string, number | null>;
  index: number;
  indexSma200: number | null;
}

export interface DailyTable {
  assets: readonly string[];
  weights: Readonly<Record<string, number>>;
  rows: DailyRow[];
  rowByClose: Map<number, number>;
}

function trailingMean(values: readonly number[], end: number, length: number): number | null {
  if (end + 1 < length) return null;
  let sum = 0;
  for (let i = end - length + 1; i <= end; i += 1) sum += values[i]!;
  return sum / length;
}

/**
 * Builds the table over the tradable assets. Fails loudly on a missing daily candle: the certified
 * bundle has none, and a hole would silently turn a close-to-close return into a two-day one.
 */
export function buildDailyTable(tape: Tape, basket: Readonly<Record<string, number>>): DailyTable {
  const assets = [...tape.tradable];
  const byAsset = new Map<string, Map<number, number>>();
  for (const asset of assets) {
    const daily = tape.tapes[asset]?.daily;
    if (!daily || daily.length === 0) throw new Error(`exit daily: ${asset} has no daily candle`);
    byAsset.set(asset, new Map(daily.map((c) => [c.timestamp + DAY_MS, c.close])));
  }
  let common: number[] | null = null;
  for (const asset of assets) {
    const closes = [...byAsset.get(asset)!.keys()];
    common = common == null ? closes : common.filter((t) => byAsset.get(asset)!.has(t));
  }
  const closesMs = (common ?? []).sort((a, b) => a - b);
  if (closesMs.length === 0) throw new Error('exit daily: no common daily close');
  for (let i = 1; i < closesMs.length; i += 1) {
    if (closesMs[i]! - closesMs[i - 1]! !== DAY_MS) {
      throw new Error(`exit daily: missing daily close between ${new Date(closesMs[i - 1]!).toISOString()} and ${new Date(closesMs[i]!).toISOString()}`);
    }
  }
  for (const asset of assets) {
    if (byAsset.get(asset)!.size !== closesMs.length) {
      throw new Error(`exit daily: ${asset} has daily closes outside the common grid`);
    }
  }

  const basketSum = assets.reduce((s, a) => s + (basket[a] ?? 0), 0);
  if (Math.abs(basketSum - 100) > 1e-9) throw new Error(`exit daily: the basket sums to ${basketSum}`);
  const weights = Object.fromEntries(assets.map((a) => [a, (basket[a] ?? 0) / 100]));

  const series = Object.fromEntries(assets.map((a) => [a, closesMs.map((t) => byAsset.get(a)!.get(t)!)]));
  const index: number[] = [];
  for (let i = 0; i < closesMs.length; i += 1) {
    if (i === 0) {
      index.push(100);
      continue;
    }
    let growth = 0;
    for (const a of assets) growth += weights[a]! * (series[a]![i]! / series[a]![i - 1]!);
    index.push(index[i - 1]! * growth);
  }

  const rows: DailyRow[] = closesMs.map((closeMs, i) => ({
    closeMs,
    close: Object.fromEntries(assets.map((a) => [a, series[a]![i]!])),
    sma50: Object.fromEntries(assets.map((a) => [a, trailingMean(series[a]!, i, EXIT_PARAMETERS.shortMeanDays)])),
    sma200: Object.fromEntries(assets.map((a) => [a, trailingMean(series[a]!, i, EXIT_PARAMETERS.longMeanDays)])),
    index: index[i]!,
    indexSma200: trailingMean(index, i, EXIT_PARAMETERS.longMeanDays),
  }));
  return { assets, weights, rows, rowByClose: new Map(rows.map((r, i) => [r.closeMs, i])) };
}

/** The last daily close known at instant `ms` (a close AT `ms` is known), or null. */
export function lastRowAtOrBefore(table: DailyTable, ms: number): DailyRow | null {
  const closeMs = Math.floor(ms / DAY_MS) * DAY_MS;
  const i = table.rowByClose.get(closeMs);
  if (i != null) return table.rows[i]!;
  // Before the first close, or (never in the certified data) inside a hole: walk back.
  for (let k = table.rows.length - 1; k >= 0; k -= 1) if (table.rows[k]!.closeMs <= ms) return table.rows[k]!;
  return null;
}

// ── §6 — THE START OF THE DEVELOPMENT WINDOW, COMPUTED ─────────────────────────────────

export interface StartRequirement {
  name: string;
  firstMs: number | null;
}

/**
 * The first UTC midnight at which EVERY policy — references and candidates — has its indicators
 * causally, SOL and the global context included (§6). Each requirement is published with its own
 * first date, so the binding one is visible rather than asserted.
 *
 *   regime        every input of production's classifier and of the risk_off breadth is defined
 *                 for all five regime assets at the regime point of that instant, with FULL
 *                 windows: 30 closed daily candles for the monthly range, 42 closed 4h bars for
 *                 the tactical one (production accepts partial windows; "available causally"
 *                 does not). Read by the gate of every policy and by E1 and TC44's stop.
 *   sma200        each tradable asset's 200-day mean (S1, S2).
 *   sma50         each tradable asset's 50-day mean (S3, S4).
 *   index_sma200  the synthetic index's 200-day mean (S5).
 *
 * The instant is a midnight because the rules decide on daily closes; at that instant the daily
 * candle closing then is known (§4), and the regime point of the 4h bar opening then reads the
 * daily candles closed by it, as production does.
 */
export function developmentStart(tape: Tape, table: DailyTable, toMs: number): { startMs: number; requirements: StartRequirement[] } {
  const th = productionConfig.regime.thresholds;
  const first: Record<string, number | null> = { regime: null, sma200: null, sma50: null, index_sma200: null };
  const dailyCount = (asset: string, t: number): number =>
    tape.tapes[asset]!.daily.filter((c) => c.timestamp + DAY_MS <= t).length;

  for (const point of tape.points) {
    const t = point.timestamp;
    if (t % DAY_MS !== 0 || t >= toMs) continue;
    if (first.regime == null) {
      const complete = tape.regimeAssets.every((asset) => {
        const s = point.assets[asset]?.signals;
        const barIndex = tape.tapes[asset]!.indexByTs.get(t);
        return (
          s != null &&
          s.sma50 != null &&
          s.ema21Daily != null &&
          s.rsi14Daily != null &&
          s.ema21H4 != null &&
          s.rsi14H4 != null &&
          barIndex != null &&
          barIndex + 1 >= th.h4RangeBars &&
          dailyCount(asset, t) >= th.rangeWindowDays
        );
      });
      if (complete && point.global.assetsPresent === tape.regimeAssets.length) first.regime = t;
    }
    if (first.regime != null) break;
  }
  // The daily means are read off the daily closes themselves, not the 4h grid: their first date is
  // published as it is, even when it precedes the grid (which starts with SOL, 2020-08-11).
  for (const row of table.rows) {
    if (row.closeMs >= toMs) break;
    if (first.sma200 == null && table.assets.every((a) => row.sma200[a] != null)) first.sma200 = row.closeMs;
    if (first.sma50 == null && table.assets.every((a) => row.sma50[a] != null)) first.sma50 = row.closeMs;
    if (first.index_sma200 == null && row.indexSma200 != null) first.index_sma200 = row.closeMs;
  }
  const requirements = Object.entries(first).map(([name, firstMs]) => ({ name, firstMs }));
  const missing = requirements.filter((r) => r.firstMs == null);
  if (missing.length > 0) throw new Error(`exit development start: never available — ${missing.map((r) => r.name).join(', ')}`);
  return { startMs: Math.max(...requirements.map((r) => r.firstMs!)), requirements };
}

// ── §9 — THE CRASH EPISODES ─────────────────────────────────────────────────────────────

export interface CrashEpisode {
  /** The last index high before the 30 % line was crossed: the episode starts there. */
  startMs: number;
  peakIndex: number;
  /** The first close at or below 70 % of that high. */
  crossedMs: number;
  /** The lowest index close of the episode. */
  troughMs: number;
  troughIndex: number;
  depthPercent: number;
  /** The close that regains the high, or the last close of the data. */
  endMs: number;
  recovered: boolean;
}

/**
 * Episodes of the synthetic index over the closes in `[fromMs, toMs]` (the close AT `toMs` is the
 * last one of the data), the rolling high starting at the first of them. A new episode can only
 * start once the previous one has recovered; while one is open, deeper lows deepen it.
 */
export function crashEpisodes(table: DailyTable, fromMs: number, toMs: number, thresholdPercent = CRASH_THRESHOLD_PERCENT): CrashEpisode[] {
  const rows = table.rows.filter((r) => r.closeMs >= fromMs && r.closeMs <= toMs);
  if (rows.length === 0) return [];
  const line = 1 - thresholdPercent / 100;
  const out: CrashEpisode[] = [];
  let peak = rows[0]!.index;
  let peakMs = rows[0]!.closeMs;
  let open: CrashEpisode | null = null;
  for (const r of rows) {
    if (open) {
      if (r.index < open.troughIndex) {
        open.troughIndex = r.index;
        open.troughMs = r.closeMs;
      }
      if (r.index >= open.peakIndex) {
        open.endMs = r.closeMs;
        open.recovered = true;
        open.depthPercent = (1 - open.troughIndex / open.peakIndex) * 100;
        out.push(open);
        open = null;
        peak = r.index;
        peakMs = r.closeMs;
      }
      continue;
    }
    if (r.index >= peak) {
      peak = r.index;
      peakMs = r.closeMs;
    } else if (r.index <= peak * line) {
      open = { startMs: peakMs, peakIndex: peak, crossedMs: r.closeMs, troughMs: r.closeMs, troughIndex: r.index, depthPercent: 0, endMs: r.closeMs, recovered: false };
    }
  }
  if (open) {
    open.endMs = rows[rows.length - 1]!.closeMs;
    open.depthPercent = (1 - open.troughIndex / open.peakIndex) * 100;
    out.push(open);
  }
  return out;
}
