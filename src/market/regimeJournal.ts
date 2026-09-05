import { parseZonedInstant } from '../time/instants.js';
import type { AssetRegime, RegimeJournal, RegimePoint } from './regime.js';

/**
 * READING BACK A JOURNALED REGIME — one validation, one rehydration, two readers.
 *
 * `decisions.regime` holds a `RegimeJournal`: the confirmed per-asset regimes after
 * hysteresis, the raw labels, the global `risk_off` posture and the signals behind them,
 * stamped with the 4h bar they were computed on. That is exactly, field for field, what
 * `readContext` needs — so anything that wants to know what the controller WOULD have read
 * on a past cycle rehydrates the journal and calls production's own function.
 *
 * Written for the exposure observer (PR #37) and extracted here when the exposure-band
 * pilot's historical replay became the second consumer. The extraction is not tidiness: the
 * observer's Proof 4 forbids any file outside `src/observation` from importing it, so the
 * replay's only alternatives were to weaken that proof or to write a second parser. A second
 * parser is the worse option by a distance — two validators of the same jsonb drift, and the
 * failure is silent in the way this file exists to prevent (a `barAt` accepted by one reader
 * and read in the host timezone by the other produces two different bar keys for one bar).
 *
 * PURE. No clock, no I/O, no config. Everything it refuses, it refuses by throwing with the
 * field named, so a caller can turn it into a reported reason rather than a crash.
 */

/** The five directional labels the regime enum can produce. */
export const REGIMES: ReadonlySet<string> = new Set<AssetRegime>([
  'range',
  'trend_up',
  'trend_down',
  'reversal_up',
  'reversal_down',
]);

/** The five directional labels PLUS the posture — the vocabulary of `effective`, and of it alone. */
export const EFFECTIVE_REGIMES: ReadonlySet<string> = new Set([...REGIMES, 'risk_off']);

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
  const timestamp = parseZonedInstant(journal.barAt);
  if (timestamp == null) {
    throw new Error(
      'regime journal carries a barAt without an explicit timezone ' +
        `("${journal.barAt}") — refusing to read it in the host timezone`,
    );
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
 * and the shape read here have drifted apart, and a reader that quietly degraded it to
 * "no context" would hide exactly the defect it should be shouting about.
 */
export function parseRegimeJournal(raw: unknown): RegimeJournal | null {
  if (raw == null) return null;
  if (!isRecord(raw)) throw new Error('regime is not an object');
  const { version, barAt, global, assets } = raw;
  if (typeof version !== 'string') throw new Error('regime.version is not a string');
  // PARSABILITY AND AN EXPLICIT ZONE, not just a type. Two distinct traps:
  //
  //   - a string `barAt` nobody can parse is as unusable as a missing one, and where it is
  //     rejected decides what happens: validated HERE it is caught by the caller and reported
  //     as a malformed journal; validated only in `regimePointFromJournal` it would throw
  //     OUTSIDE that guard and abort the run — taking with it the failed check meant to report
  //     it, and the whole run;
  //   - a parsable but zone-free `barAt` is worse than either, because nothing fails: it is
  //     read in the host timezone, so the same window acquires different bar keys, different
  //     groupings and different artefact bytes under a different `TZ`. Production writes
  //     `toISOString()`, so this cannot happen today — which is exactly why it must be refused
  //     rather than trusted.
  if (typeof barAt !== 'string') throw new Error('regime.barAt is not a string');
  if (parseZonedInstant(barAt) == null) {
    throw new Error(`regime.barAt is not an instant with an explicit timezone ("${barAt}")`);
  }
  if (!isRecord(global)) throw new Error('regime.global is not an object');
  if (typeof global.riskOff !== 'boolean') throw new Error('regime.global.riskOff is not a boolean');
  if (typeof global.raw !== 'boolean') throw new Error('regime.global.raw is not a boolean');
  // The GLOBAL block gets the same treatment as the per-asset ones, and for the same reason:
  // it is cast wholesale into a `GlobalPosture`, and its numeric fields are published through
  // a null-tolerant helper downstream, which turns a missing or wrongly typed value into a
  // clean `null`. A corrupted breadth would therefore reach an artefact as "not measured" with
  // every check green — indistinguishable, to any later reader, from a bar where it genuinely
  // was not.
  for (const field of ['breadthPercent', 'assetsPresent', 'assetsExpected', 'pendingBars'] as const) {
    const value = global[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`regime.global.${field} is not a finite number (got ${String(value)})`);
    }
  }
  // Nullable BY CONTRACT — no asset produced a 4h RSI on that bar — so null is a fact here,
  // not a hole. Any other non-number is still a defect.
  if (
    !(
      global.medianH4Rsi === null ||
      (typeof global.medianH4Rsi === 'number' && Number.isFinite(global.medianH4Rsi))
    )
  ) {
    throw new Error(
      `regime.global.medianH4Rsi is neither null nor a finite number (got ${String(global.medianH4Rsi)})`,
    );
  }
  if (!isRecord(assets)) throw new Error('regime.assets is not an object');
  // EVERY field the cast below promises, not only the ones any one reader uses.
  //
  // The cast turns an untyped jsonb into a `RegimeJournal`, and the type system then believes
  // it. A journal missing `effective` would sail through, a context builder would report
  // success, its malformed-journal check would stay green — and `JSON.stringify` would simply
  // OMIT the undefined key from the published context. A field that vanishes from an artefact
  // while every check passes is the exact failure mode this validation exists to make
  // impossible.
  for (const [asset, entry] of Object.entries(assets)) {
    if (!isRecord(entry)) throw new Error(`regime.assets.${asset} is not an object`);
    if (typeof entry.regime !== 'string' || !REGIMES.has(entry.regime)) {
      throw new Error(`regime.assets.${asset}.regime is not a known regime (got ${String(entry.regime)})`);
    }
    if (typeof entry.raw !== 'string' || !REGIMES.has(entry.raw)) {
      throw new Error(`regime.assets.${asset}.raw is not a known regime (got ${String(entry.raw)})`);
    }
    // `risk_off` is admissible here and nowhere else: `effective` is the only field that
    // carries the portfolio POSTURE alongside the five directional labels.
    if (typeof entry.effective !== 'string' || !EFFECTIVE_REGIMES.has(entry.effective)) {
      throw new Error(
        `regime.assets.${asset}.effective is not a known effective regime (got ${String(entry.effective)})`,
      );
    }
    if (
      !(entry.pendingRegime === null || (typeof entry.pendingRegime === 'string' && REGIMES.has(entry.pendingRegime)))
    ) {
      throw new Error(`regime.assets.${asset}.pendingRegime is neither null nor a known regime`);
    }
    if (typeof entry.pendingBars !== 'number' || !Number.isFinite(entry.pendingBars)) {
      throw new Error(`regime.assets.${asset}.pendingBars is not a finite number`);
    }
    if (typeof entry.bearish !== 'boolean') throw new Error(`regime.assets.${asset}.bearish is not a boolean`);
    if (!isRecord(entry.signals)) throw new Error(`regime.assets.${asset}.signals is not an object`);
  }
  return raw as unknown as RegimeJournal;
}
