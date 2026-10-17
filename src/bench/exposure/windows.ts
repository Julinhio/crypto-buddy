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
  readonly name: 'development' | 'verification' | 'validation';
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
export function assertMeasurable(window: Window): void {
  if (window.name === 'development') {
    if (window.fromMs !== DEVELOPMENT.fromMs || window.toMs !== DEVELOPMENT.toMs) {
      throw new ClosedWindowError(window, 'a window named "development" must have the development bounds');
    }
    return;
  }
  if (window.name === 'verification') {
    throw new ClosedWindowError(window, 'it opens only after the SCORE variants are frozen (protocol v1.3, point 5)');
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
