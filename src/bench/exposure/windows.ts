import { isGenuineOpening, type VerificationOpening } from './opening.js';
import { isGenuineSealedOpening, type SealedOpening } from '../exit/opening.js';

/**
 * THE WINDOWS OF PROTOCOL v1.3, AND THE ONE RULE THAT DECIDES WHICH OF THEM MAY BE READ.
 *
 * See `docs/PROTOCOLE-EXPOSITION-v1.3.md`, points 3 and 4.
 *
 *   calibration   [2021-01-01, 2024-07-01)
 *     development   [2021-01-01, 2023-01-01)   open in step 1
 *     verification  [2023-01-01, 2024-07-01)   CLOSED until the SCORE variants are frozen
 *   validation    [2024-07-01, 2026-06-01)   SEALED, its files live outside every repository
 *
 * Every window is semi-open, so no bar can belong to two of them.
 *
 * ── WHY THE VERIFICATION WINDOW HAS NO "OPEN" SWITCH HERE ─────────────────────────────
 *
 * Step 1 of the bench measures the development window only. A flag that opened the internal
 * verification would be one keystroke away from the thing the protocol forbids — measuring a
 * relation, seeing it fail on the second half, and adjusting before the variants are frozen.
 * So the switch does not exist yet. The step that freezes the SCORE variants will add it,
 * conditioned on the frozen file, exactly as `validate.ts` conditioned the old sealed window
 * on a committed selection.
 */

export interface Window {
  readonly name: 'development' | 'verification' | 'validation' | 'calibration' | 'exit-development' | 'exit-continuous' | 'exit-sealed';
  readonly fromMs: number;
  /** EXCLUSIVE. */
  readonly toMs: number;
}

/** The instant the seal starts. No candle OPENED at or after it may reach a calibration path. */
export const SEAL_INSTANT_MS = Date.parse('2024-07-01T00:00:00.000Z');

export const DEVELOPMENT: Window = Object.freeze({
  name: 'development',
  fromMs: Date.parse('2021-01-01T00:00:00.000Z'),
  toMs: Date.parse('2023-01-01T00:00:00.000Z'),
});

export const VERIFICATION: Window = Object.freeze({
  name: 'verification',
  fromMs: Date.parse('2023-01-01T00:00:00.000Z'),
  toMs: SEAL_INSTANT_MS,
});

export const VALIDATION: Window = Object.freeze({
  name: 'validation',
  fromMs: SEAL_INSTANT_MS,
  toMs: Date.parse('2026-06-01T00:00:00.000Z'),
});

/** The whole calibration, for continuous-trajectory metrics only — never a run's own window. */
export const CALIBRATION: Window = Object.freeze({
  name: 'calibration',
  fromMs: Date.parse('2021-01-01T00:00:00.000Z'),
  toMs: SEAL_INSTANT_MS,
});

/**
 * THE DEVELOPMENT WINDOW OF THE EXIT EXPERIMENT — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, §6.
 *
 * Everything before the seal, from the first midnight at which every policy of that experiment has
 * its indicators causally. That instant is COMPUTED (`developmentStart`, `src/bench/exit/daily.ts`)
 * and pinned here once the audit published it; the exit run recomputes it and refuses to measure if
 * the two ever differ. The binding requirement is SOL's 50-day mean, read by the regime classifier
 * and the risk_off breadth: the grid only starts with SOL (2020-08-11T04:00Z).
 *
 * The whole period is CONSUMED (v1.3's internal verification was opened once, `1715f0f`): learning
 * and sub-period reading only, never independent proof. The seal does not move.
 */
export const EXIT_DEVELOPMENT: Window = Object.freeze({
  name: 'exit-development',
  fromMs: Date.parse('2020-10-01T00:00:00.000Z'),
  toMs: SEAL_INSTANT_MS,
});

/**
 * THE CONTINUOUS TRAJECTORY OF THE EXIT EXPERIMENT'S SEALED VALIDATION — protocol
 * `docs/PROTOCOLE-SORTIE-v0.4.md`, §16: one replay from the exit development's start to the end of
 * the sealed window, so that the state, the trailing highs and the equity high cross 2024-07-01 as
 * they would have lived. It reads the sealed window, so it is measurable ONLY with a genuine sealed
 * opening (`src/bench/exit/opening.ts`), issued once, after the v0.4 freeze is committed and public.
 */
export const EXIT_CONTINUOUS: Window = Object.freeze({
  name: 'exit-continuous',
  fromMs: EXIT_DEVELOPMENT.fromMs,
  toMs: VALIDATION.toMs,
});

/** The sealed window as the exit experiment reads it: a SLICE of `EXIT_CONTINUOUS`, never a run's own window. */
export const EXIT_SEALED: Window = Object.freeze({
  name: 'exit-sealed',
  fromMs: SEAL_INSTANT_MS,
  toMs: VALIDATION.toMs,
});

export class ClosedWindowError extends Error {
  constructor(window: Window, why: string) {
    super(`window "${window.name}" is closed: ${why}`);
    this.name = 'ClosedWindowError';
  }
}

/**
 * The only gate a measurement passes through. Step 1: development, and nothing else.
 *
 * Called by every entry point that turns bars into a number — the replay, the predictive
 * study — so a measurement on a closed window fails at its first line rather than relying on
 * the caller having picked the right constant.
 */
export function assertMeasurable(window: Window, opening?: VerificationOpening, sealedOpening?: SealedOpening): void {
  if (window.name === 'development') {
    if (window.fromMs !== DEVELOPMENT.fromMs || window.toMs !== DEVELOPMENT.toMs) {
      throw new ClosedWindowError(window, 'a window named "development" must have the development bounds');
    }
    return;
  }
  if (window.name === 'verification') {
    // A GENUINE opening, issued by `openVerification` (opening.ts) — never a look-alike.
    if (!isGenuineOpening(opening)) {
      throw new ClosedWindowError(window, 'it opens only on a committed freeze of the candidate (protocol v1.3, point 10)');
    }
    if (window.fromMs !== VERIFICATION.fromMs || window.toMs !== VERIFICATION.toMs) {
      throw new ClosedWindowError(window, 'a window named "verification" must have the verification bounds');
    }
    return;
  }
  if (window.name === 'exit-development') {
    if (window.fromMs !== EXIT_DEVELOPMENT.fromMs || window.toMs !== EXIT_DEVELOPMENT.toMs) {
      throw new ClosedWindowError(window, 'a window named "exit-development" must have the bounds the exit audit computed');
    }
    return;
  }
  if (window.name === 'exit-continuous') {
    if (!isGenuineSealedOpening(sealedOpening)) {
      throw new ClosedWindowError(window, 'it reads the sealed window, which opens once, on the committed and pushed v0.4 freeze');
    }
    if (window.fromMs !== EXIT_CONTINUOUS.fromMs || window.toMs !== EXIT_CONTINUOUS.toMs) {
      throw new ClosedWindowError(window, 'a window named "exit-continuous" must have the continuous bounds');
    }
    return;
  }
  throw new ClosedWindowError(window, 'the validation window is sealed and opens once, after the candidate is committed');
}

/**
 * THE EMBARGO — a signal whose horizon crosses the window's end does not enter a fit.
 *
 * A signal read at `signalMs` and measured over a return that ends on the open of the bar at
 * `exitOpenMs` belongs to the window only if both ends do. The exit is an OPEN, and the open
 * of the first bar of the next window is a price of the next window: `exitOpenMs < toMs` is
 * strict, never `<=`.
 */
export function insideWithEmbargo(window: Window, signalMs: number, exitOpenMs: number): boolean {
  return signalMs >= window.fromMs && exitOpenMs < window.toMs;
}
