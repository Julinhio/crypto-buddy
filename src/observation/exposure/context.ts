import { config, tradableBaseAssets } from '../../config/index.js';
import type { AssetRegime, AssetSignals, RegimeJournal, RegimePoint } from '../../market/regime.js';
import { buildExperimentConfig } from '../../calibration/exposure/config.js';
import { readContext, type ControllerReading } from '../../calibration/exposure/controller.js';

/**
 * THE DETERMINISTIC CONTEXT THE CONTROLLER CONSUMES — rebuilt from what the bot ALREADY
 * journaled, and read by PRODUCTION'S OWN function.
 *
 * `decisions.regime` holds a `RegimeJournal`: the confirmed per-asset regimes after
 * hysteresis, the raw labels, the global `risk_off` posture and the signals behind them, all
 * stamped with the 4h bar they were computed on. That is exactly, field for field, what
 * `readContext` needs. So this module does one thing: it rehydrates the journal into the
 * `RegimePoint` the controller expects and calls `readContext`. It reimplements nothing —
 * a context this file computed itself would be a second opinion about a number production
 * already owns.
 *
 * ── NO BAND ENTERS HERE ────────────────────────────────────────────────────────────────
 *
 * `readContext` maps context to one of three STATES. It knows nothing about A, B or C: the
 * bands live in `arms.ts`, which nothing in `observation/` imports, and a test greps for it.
 * The snapshot records the state and the breadth that produced it — never a target, never a
 * score.
 *
 * ── THE UNIVERSE, AND A REAL DIVERGENCE WORTH READING TWICE ────────────────────────────
 *
 * The controller is defined over the assets it can allocate to: the caps table, which is
 * where `buildExperimentConfig().assets` comes from. Production's REGIME, however, is
 * computed over TRADABLE **AND** REFERENCE pairs — five assets today (the four tradables
 * plus SOL, which the bot watches and never trades, see `readRegime` in `context/build.ts`).
 *
 * Two consequences, both recorded rather than smoothed over:
 *
 *   - `netBreadth` here is computed over the FOUR allocatable assets, which is the universe
 *     the controller was calibrated on. The reference pair contributes nothing to it.
 *   - `riskOff` is production's, taken verbatim from the journal, and production computes it
 *     over FIVE. The calibration harness computed the same posture over four, because its
 *     bundle carried four. The two estimators are therefore NOT the same, and the `state`
 *     this module reports inherits that: its `defensive` branch is production's five-asset
 *     posture, its constructive/neutral split is a four-asset breadth.
 *
 * That is a property of the live data, not a choice this brick is free to make — production
 * owns `risk_off` and the snapshot reports what the bot actually saw. It is journaled
 * explicitly (`journal_global`, `journal_only_assets`) so no later analysis can compare a
 * live band-state to a calibrated one without meeting the difference first.
 */

export interface ContextAssetView {
  /** The confirmed regime after hysteresis — the label the controller counts. */
  regime: AssetRegime | null;
  /** `risk_off` when the global override is active, else the confirmed regime. */
  effective: string | null;
  /** The unsmoothed label at that bar. The gap with `regime` is the transition defect. */
  raw: AssetRegime | null;
  bearish: boolean | null;
  /** True when the journal carried no point at all for this asset on that bar. */
  absent: boolean;
}

export interface ControllerContext {
  /** The 4h bar the regime was computed on — NOT the wake-up time. */
  bar_at: string;
  regime_version: string;
  /** The assets the controller reads. Sorted, so the field is stable across runs. */
  universe: string[];
  /** `defensive` / `neutral` / `constructive`, from production's own `readContext`. */
  state: ControllerReading['state'];
  risk_off: boolean;
  net_breadth: number;
  bullish: number;
  bearish: number;
  neutral: number;
  /** Universe assets with no point on that bar. Counted, never guessed at. */
  unavailable: number;
  assets: Record<string, ContextAssetView>;
  /**
   * The journal's own global block, verbatim. `breadth_percent` and `risk_off` here are
   * production's estimator over its FIVE-asset universe — see the header.
   */
  journal_global: {
    risk_off: boolean;
    raw: boolean;
    breadth_percent: number | null;
    /** The RSI brake's only input. Recorded as a fact; no brake is applied here. */
    median_h4_rsi: number | null;
    assets_present: number | null;
    assets_expected: number | null;
    pending_bars: number | null;
  };
  /** Assets the journal carries that the controller does not allocate to (reference pairs). */
  journal_only_assets: string[];
}

export type ContextResult =
  | { ok: true; context: ControllerContext }
  | { ok: false; reason: 'no_regime_journaled' | 'malformed_regime_journal'; detail: string };

/**
 * The controller's universe, and the proof that it is the bot's.
 *
 * Taken from the experiment configuration — the caps table — because that is the universe
 * the controller was calibrated over. Cross-checked against the tradable pairs, because a
 * silent divergence between "what the bot can trade" and "what the controller reads" would
 * put a phantom asset in the breadth denominator and move every state boundary by a
 * fraction nobody would see.
 */
export function controllerUniverse(): string[] {
  const fromCaps = [...buildExperimentConfig().assets].sort();
  const fromPairs = [...tradableBaseAssets(config)].sort();
  if (fromCaps.join(',') !== fromPairs.join(',')) {
    throw new Error(
      `exposure observation: the caps table describes [${fromCaps.join(', ')}] but the tradable ` +
        `pairs are [${fromPairs.join(', ')}] — the controller would read a universe the bot does ` +
        'not trade. Refusing to produce a snapshot on a denominator that means nothing.',
    );
  }
  return fromCaps;
}

const REGIMES: ReadonlySet<string> = new Set<AssetRegime>([
  'range',
  'trend_up',
  'trend_down',
  'reversal_up',
  'reversal_down',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rehydrates the stored journal into the `RegimePoint` production's controller expects.
 *
 * Faithful, not approximate: every field `readContext` can reach comes from the journal, and
 * the bar timestamp is the journal's own `barAt` rather than the wake-up time. The signals
 * are carried through untouched — the controller never reads them, but a `RegimePoint` that
 * dropped them would be a different object than the one production hands its own functions.
 */
export function regimePointFromJournal(journal: RegimeJournal): RegimePoint {
  const timestamp = Date.parse(journal.barAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`exposure observation: regime journal carries an unparsable barAt "${journal.barAt}"`);
  }
  const assets: RegimePoint['assets'] = {};
  for (const [asset, entry] of Object.entries(journal.assets)) {
    assets[asset] = {
      regime: entry.regime,
      raw: entry.raw,
      pendingBars: entry.pendingBars,
      pendingRegime: entry.pendingRegime,
      bearish: entry.bearish,
      signals: entry.signals,
    };
  }
  return { timestamp, at: journal.barAt, global: journal.global, assets };
}

/**
 * Validates the jsonb enough to rehydrate it, and refuses anything it cannot vouch for.
 *
 * A journal that is ABSENT is a documented, legitimate state — production writes `null` when
 * no 4h series was usable, and the cycle stays in the population with no context. A journal
 * that is PRESENT but malformed is a different animal: it means the shape written by the bot
 * and the shape read here have drifted apart, and a snapshot that quietly degraded it to
 * "no context" would hide exactly the defect it should be shouting about.
 */
export function parseRegimeJournal(raw: unknown): RegimeJournal | null {
  if (raw == null) return null;
  if (!isRecord(raw)) throw new Error('regime is not an object');
  const { version, barAt, global, assets } = raw;
  if (typeof version !== 'string') throw new Error('regime.version is not a string');
  // PARSABILITY, not just type. A string `barAt` nobody can parse is exactly as unusable as a
  // missing one, and the difference matters here: validated below, it is caught by the caller
  // and classified as a malformed journal; validated only in `regimePointFromJournal`, it would
  // throw OUTSIDE that guard and abort the whole run without producing the snapshot — or the
  // failed check that exists to report it.
  if (typeof barAt !== 'string') throw new Error('regime.barAt is not a string');
  if (!Number.isFinite(Date.parse(barAt))) throw new Error(`regime.barAt is not a parsable instant ("${barAt}")`);
  if (!isRecord(global)) throw new Error('regime.global is not an object');
  if (typeof global.riskOff !== 'boolean') throw new Error('regime.global.riskOff is not a boolean');
  if (!isRecord(assets)) throw new Error('regime.assets is not an object');
  for (const [asset, entry] of Object.entries(assets)) {
    if (!isRecord(entry)) throw new Error(`regime.assets.${asset} is not an object`);
    if (typeof entry.regime !== 'string' || !REGIMES.has(entry.regime)) {
      throw new Error(`regime.assets.${asset}.regime is not a known regime (got ${String(entry.regime)})`);
    }
    if (typeof entry.raw !== 'string' || !REGIMES.has(entry.raw)) {
      throw new Error(`regime.assets.${asset}.raw is not a known regime (got ${String(entry.raw)})`);
    }
    if (!isRecord(entry.signals)) throw new Error(`regime.assets.${asset}.signals is not an object`);
  }
  return raw as unknown as RegimeJournal;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Builds the controller context for one cycle, or says precisely why it could not. */
export function contextOf(rawRegime: unknown, universe: readonly string[]): ContextResult {
  let journal: RegimeJournal | null;
  try {
    journal = parseRegimeJournal(rawRegime);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_regime_journal',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (journal == null) {
    return {
      ok: false,
      reason: 'no_regime_journaled',
      detail: 'the cycle journaled no regime — no usable 4h series, or no closed bar in common',
    };
  }

  const point = regimePointFromJournal(journal);
  // PRODUCTION'S FUNCTION, called on production's data. It throws `UnknownRegimeError` on a
  // label its table does not classify, and that throw is wanted: a new regime silently
  // counted as neutral would move every boundary for months.
  const reading = readContext(point, universe);

  const assets: Record<string, ContextAssetView> = {};
  for (const asset of universe) {
    const entry = journal.assets[asset];
    assets[asset] = entry
      ? {
          regime: entry.regime,
          effective: entry.effective,
          raw: entry.raw,
          bearish: entry.bearish,
          absent: false,
        }
      : { regime: null, effective: null, raw: null, bearish: null, absent: true };
  }

  const inUniverse = new Set(universe);
  const g = journal.global as unknown as Record<string, unknown>;

  return {
    ok: true,
    context: {
      bar_at: new Date(point.timestamp).toISOString(),
      regime_version: journal.version,
      universe: [...universe],
      state: reading.state,
      risk_off: reading.riskOff,
      net_breadth: reading.netBreadth,
      bullish: reading.bullish,
      bearish: reading.bearish,
      neutral: reading.neutral,
      unavailable: reading.unavailable,
      assets,
      journal_global: {
        risk_off: journal.global.riskOff,
        raw: g.raw === true,
        breadth_percent: numberOrNull(g.breadthPercent),
        median_h4_rsi: numberOrNull(g.medianH4Rsi),
        assets_present: numberOrNull(g.assetsPresent),
        assets_expected: numberOrNull(g.assetsExpected),
        pending_bars: numberOrNull(g.pendingBars),
      },
      journal_only_assets: Object.keys(journal.assets)
        .filter((asset) => !inUniverse.has(asset))
        .sort(),
    },
  };
}

/** Re-exported for the tests, which assert the rehydration round-trips exactly. */
export type { AssetSignals, ControllerReading };
