import path from 'node:path';
import { config } from '../../config/index.js';
import { parseZonedInstant } from './instants.js';

/**
 * THE WINDOW — half-open `[from, cutoff)`, both bounds EXPLICIT, neither defaulted.
 *
 * Two bounds a caller has to type, on purpose. A default would be a hidden parameter of every
 * number the snapshot publishes: re-run the tool a week later with the same command line and
 * a defaulted cutoff would silently extract a different population, while the output folder
 * looked exactly the same. The cutoff is the one thing this brick promises to make explicit,
 * so it is not something the tool may invent.
 *
 * Half-open, so two adjacent windows can never both claim the same cycle.
 */
export interface ObservationWindow {
  fromMs: number;
  /** EXCLUSIVE. A cycle at exactly this instant belongs to the next window. */
  toMs: number;
  from: string;
  toExclusive: string;
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}

/**
 * A CYCLE IS NOT ATOMIC, AND THE CUTOFF HAS TO RESPECT THAT.
 *
 * `decide()` inserts the decision row FIRST, then places the orders, then journals the
 * executions and the transition observations. A cutoff landing inside that sequence would
 * capture a decision whose movements and verdicts had not been written yet — and the
 * snapshot would record, permanently and with a clean digest, a cycle that traded nothing
 * and saw nothing. Worse: re-running the same cutoff an hour later would produce a DIFFERENT
 * snapshot from the same command line, which is precisely the property this brick sells.
 *
 * So the cutoff must be old enough that any cycle before it has necessarily finished. The
 * bound used is the run-lock TTL rather than the cycle budget: the lock is what production
 * guarantees no cycle outlives (`lockTtlSeconds > maxCycleSeconds + grace`, enforced at
 * boot), so it is the honest upper bound on "a wake-up that started before T is over".
 */
export function settleMarginSeconds(): number {
  return config.scheduler.lockTtlSeconds;
}

/** Parses one `--flag value` pair out of argv. Returns null when the flag is absent. */
function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value == null || value.startsWith('--')) {
    throw new WindowError(`--${name} needs a value (ISO-8601 UTC, e.g. 2026-08-12T00:00:00Z)`);
  }
  return value;
}

/**
 * AN EXPLICIT ZONE IS REQUIRED, and that is a reproducibility rule rather than pedantry.
 *
 * A zone-free bound resolves in the HOST's local timezone, so the identical command line would
 * select a different population on a laptop in Bangkok and on a runner in UTC — and the
 * artefact normalises the bound back to `Z` on its way out, so the divergence would leave no
 * trace in the very file it changed. The rule lives in `instants.ts`, shared with the journal
 * reader, so the CLI and the stored `barAt` cannot drift apart on it.
 */
function parseInstant(label: string, raw: string): number {
  const ms = parseZonedInstant(raw);
  if (ms == null) {
    throw new WindowError(
      `${label}="${raw}" is not an ISO-8601 instant with an explicit timezone (e.g. ` +
        '2026-08-12T00:00:00Z, or an offset). Without a zone the bound is read in the host ' +
        'timezone, and the same command would select a different window on another machine.',
    );
  }
  return ms;
}

export const USAGE =
  'usage: npm run observe:exposure -- --from <ISO-8601 UTC> --cutoff <ISO-8601 UTC> [--out <dir>]';

/**
 * Builds the window from argv, refusing everything ambiguous.
 *
 * `nowMs` is injected so the settle rule is testable without waiting for a clock. The CLI
 * passes the wall clock; nothing that clock touches reaches the artefacts.
 */
export function parseWindow(argv: readonly string[], nowMs: number): ObservationWindow {
  const rawFrom = flag(argv, 'from');
  const rawCutoff = flag(argv, 'cutoff');
  if (rawFrom == null || rawCutoff == null) {
    throw new WindowError(`--from and --cutoff are both required and never defaulted. ${USAGE}`);
  }
  const fromMs = parseInstant('--from', rawFrom);
  const toMs = parseInstant('--cutoff', rawCutoff);
  if (!(fromMs < toMs)) {
    throw new WindowError(`--from (${rawFrom}) must be strictly before --cutoff (${rawCutoff})`);
  }
  const marginMs = settleMarginSeconds() * 1000;
  if (toMs > nowMs - marginMs) {
    throw new WindowError(
      `--cutoff (${new Date(toMs).toISOString()}) is too recent: a cycle that started just before it ` +
        `may still be writing its executions and its transition verdicts. The cutoff must be at least ` +
        `${settleMarginSeconds()}s (the run-lock TTL) in the past — i.e. at or before ` +
        `${new Date(nowMs - marginMs).toISOString()}.`,
    );
  }
  return {
    fromMs,
    toMs,
    from: new Date(fromMs).toISOString(),
    toExclusive: new Date(toMs).toISOString(),
  };
}

/** Where the artefacts land. Defaulted, because it names nothing about the population. */
export const DEFAULT_OUT_DIR = 'out/exposure-observation';

/**
 * THE OUTPUT DIRECTORY IS CONFINED TO THE OBSERVER'S OWN NAMESPACE, and each half of that
 * sentence closes a different failure.
 *
 * UNDER `out/`, because of the manifest. It stamps `crypto_buddy_tree_dirty` — "was the source
 * really the commit I claim" — and `gitIsDirty()` answers it while deliberately ignoring
 * `out/`, since a run WRITES its artefacts before stamping and a whole-tree check would report
 * "dirty" on every single run for a reason having nothing to do with the code. Anywhere else in
 * the repository, those same writes make the tree dirty and the manifest accuses a clean source.
 *
 * UNDER `out/exposure-observation`, because `out/` is not empty. `out/exposure-calibration`
 * holds two TRACKED files — the calibration's own `summary.json` and `manifest.json` — and this
 * command writes files by those exact names: a plausible `--out out/exposure-calibration` would
 * overwrite the published calibration result with an observation, and `gitIsDirty()`'s blindness
 * to `out/` would let the replacement manifest report a clean tree while doing it. The rest of
 * `out/` has the milder version of the same problem: `.gitignore` covers this observer's folder
 * and nothing else, so an operational export written to `out/foo` sits there committable.
 *
 * Both are removed by construction rather than by computing around them.
 */
export function parseOutDir(argv: readonly string[]): string {
  const raw = flag(argv, 'out') ?? DEFAULT_OUT_DIR;
  const normalised = raw.split('\\').join('/').replace(/\/+$/, '');
  const inNamespace = normalised === DEFAULT_OUT_DIR || normalised.startsWith(`${DEFAULT_OUT_DIR}/`);
  const escapes = normalised.split('/').includes('..');
  if (path.isAbsolute(raw) || !inNamespace || escapes) {
    throw new WindowError(
      `--out="${raw}" must be "${DEFAULT_OUT_DIR}" or a descendant of it. Elsewhere under "out/" it ` +
        'would land in another brick\'s namespace — `out/exposure-calibration` holds two COMMITTED ' +
        'files with these very names — and outside "out/" the artefacts written before the manifest ' +
        'would make the tree dirty, so the manifest would stamp crypto_buddy_tree_dirty on a clean ' +
        'source. This namespace is also the only one .gitignore covers.',
    );
  }
  return normalised;
}
