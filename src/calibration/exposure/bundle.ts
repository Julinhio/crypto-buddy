import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Candle } from '../../market/klines.js';

/**
 * THE BUNDLE GATE — nothing in this harness runs on data that has not passed here.
 *
 * The candles come from `crypto-lab` (PR #1, squash `ed9bc04`), copied byte-identical into
 * this repository. The harness depends on NEITHER a neighbouring checkout NOR the network:
 * everything it needs to certify the data is in `data/calibration/`, and everything it
 * needs to certify the certification is in this file.
 *
 * WHY THE PIN IS RECOMPUTED RATHER THAN COMPARED. `manifest.bundle_sha256` is a string
 * inside the very file it certifies. Comparing it to a constant proves the manifest was
 * not swapped wholesale; it proves nothing about a manifest edited coherently — change a
 * per-file digest AND the pin together and a string comparison waves it through. So the
 * preimage is rebuilt here, from the manifest's own fields, and hashed. Combined with the
 * per-file digests (which are themselves inside that preimage), an altered candle file now
 * has to break one of three independent checks.
 *
 * There is no degraded mode. A single failed check aborts the run.
 */

/** Where the bundle lives, relative to the repository root. */
export const BUNDLE_DIR = path.join('data', 'calibration', 'crypto-buddy-exposure-v1');

/** Pinned in code, per the protocol. The bundle this harness was calibrated against. */
export const EXPECTED_BUNDLE_ID = 'crypto-buddy-exposure-v1';
export const EXPECTED_SCHEMA_VERSION = 1;
export const EXPECTED_BUNDLE_SHA256 =
  '517563c6a9ec9a29eba769049b7154a2a2a2b9c5ce6fd8730dfc019f17e487ce';
/** Eight series: four symbols × two timeframes. A missing one is a failed run. */
export const EXPECTED_FILE_COUNT = 8;

/**
 * The Binance outage of 19 February 2020, which the bundle carries as a HOLE.
 *
 * One 4h bar is missing on every 4h series (08:00Z → 16:00Z). It is never filled and never
 * interpolated — an invented bar is a fabricated price, and this harness would then be
 * calibrating a strategy against a candle that never traded. Its presence is asserted, not
 * tolerated: a bundle that had quietly grown the bar back would be a different bundle.
 */
export const EXPECTED_GAP = {
  afterOpenTime: '2020-02-19T08:00:00.000Z',
  beforeOpenTime: '2020-02-19T16:00:00.000Z',
  missingBars: 1,
} as const;

export interface SeriesEntry {
  symbol: string;
  timeframe: string;
  file: string;
  rows: number;
  first_open_time: string;
  first_close_time: string;
  last_open_time: string;
  last_close_time: string;
  duplicate_open_times_returned_by_source: number;
  duplicates_ok: boolean;
  strictly_ordered: boolean;
  gap_count: number;
  gaps: Array<{ afterOpenTime: string; beforeOpenTime: string; missingBars: number }>;
  discarded_by_admissibility: number;
  sha256: string;
}

export interface BundleManifest {
  schema_version: number;
  bundle_id: string;
  source: string;
  producer_repository: string;
  fetch_start: string;
  evaluation_start: string;
  as_of_exclusive: string;
  acquisition_config_sha256: string;
  producer_source_sha256: string;
  producer_source_files: Array<{ path: string; sha256: string }>;
  generation_git_commit: string | null;
  generation_git_commit_authority: string;
  series: SeriesEntry[];
  bundle_sha256: string;
}

/** A raw candle exactly as the producer wrote it. */
interface RawCandle {
  t: number;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  v: string | number;
}

/**
 * `crypto-lab`'s canonical form, mirrored EXACTLY: two-space JSON plus a trailing newline.
 * Any deviation — a different indent, a missing newline — yields a different digest and the
 * recomputed pin stops matching. Kept as its own named function so the mirroring is a
 * visible claim rather than an inline accident.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The preimage of `bundle_sha256`, rebuilt field for field from `crypto-lab`'s
 * `bundlePreimage`. Both projections are explicit and both sorts are reproduced: the digest
 * is order-sensitive, so "the same fields" is not enough — it has to be the same fields in
 * the same order with the same subset of keys.
 */
export function bundlePreimage(manifest: BundleManifest): unknown {
  return {
    bundle_id: manifest.bundle_id,
    source: manifest.source,
    fetch_start: manifest.fetch_start,
    evaluation_start: manifest.evaluation_start,
    as_of_exclusive: manifest.as_of_exclusive,
    producer_source_sha256: manifest.producer_source_sha256,
    producer_source_files: [...manifest.producer_source_files]
      .map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 }))
      .sort((left, right) => (left.path < right.path ? -1 : 1)),
    acquisition_config_sha256: manifest.acquisition_config_sha256,
    files: [...manifest.series]
      .map((item) => ({
        file: item.file,
        symbol: item.symbol,
        timeframe: item.timeframe,
        sha256: item.sha256,
        duplicate_open_times_returned_by_source: item.duplicate_open_times_returned_by_source,
        discarded_by_admissibility: item.discarded_by_admissibility,
      }))
      .sort((left, right) => (left.file < right.file ? -1 : 1)),
  };
}

export function computeBundleSha256(manifest: BundleManifest): string {
  return sha256Hex(Buffer.from(canonicalJson(bundlePreimage(manifest)), 'utf8'));
}

/**
 * THE ADMISSIBILITY RULE, copied from the producer's `isAdmissibleCandle` (three
 * independent conditions, `timeframe.mjs`).
 *
 * The close matters as much as the open, and that is the part an "as_of" reading usually
 * drops: a 4h bar opening at 20:00 on the last day closes at 23:59:59.999 — inside the
 * bound — while a daily bar opening the same day would close past it. Testing the open
 * alone would admit a candle whose price was still forming at the bundle's horizon, which
 * is look-ahead wearing a timestamp that looks fine.
 */
export function isAdmissibleCandle(
  openTimeMs: number,
  closeTimeMs: number,
  fetchStartMs: number,
  asOfExclusiveMs: number,
): boolean {
  return (
    openTimeMs >= fetchStartMs && openTimeMs < asOfExclusiveMs && closeTimeMs < asOfExclusiveMs
  );
}

export class BundleVerificationError extends Error {
  constructor(message: string) {
    super(`bundle verification failed: ${message}`);
    this.name = 'BundleVerificationError';
  }
}

export interface VerifiedBundle {
  manifest: BundleManifest;
  /** Candles per `SYMBOL:timeframe`, adapted to production's `Candle`. */
  series: Map<string, Candle[]>;
  fetchStartMs: number;
  evaluationStartMs: number;
  asOfExclusiveMs: number;
}

/** Reads a JSON file and returns both its bytes (for hashing) and its parsed value. */
function readJson(file: string): { bytes: Buffer; value: unknown } {
  const bytes = readFileSync(file);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown };
}

/**
 * Loads and CERTIFIES the bundle, then adapts it to production's `Candle`.
 *
 * The adaptation is the harness's only licence over this data: `t/o/h/l/c/v` becomes the
 * shape `market/regime.ts` already consumes. No resampling, no filling, no reordering, no
 * derived field — every number that reaches the replay is a number the producer wrote.
 *
 * Throws `BundleVerificationError` on the first failed check. `rootDir` exists so the tests
 * can point at a deliberately corrupted copy without touching the real one.
 */
export function loadVerifiedBundle(rootDir = process.cwd()): VerifiedBundle {
  const dir = path.resolve(rootDir, BUNDLE_DIR);
  const manifestPath = path.join(dir, 'manifest.json');

  let manifest: BundleManifest;
  try {
    manifest = readJson(manifestPath).value as BundleManifest;
  } catch (err) {
    throw new BundleVerificationError(
      `cannot read ${manifestPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (manifest.schema_version !== EXPECTED_SCHEMA_VERSION) {
    throw new BundleVerificationError(
      `schema_version is ${manifest.schema_version}, expected ${EXPECTED_SCHEMA_VERSION}`,
    );
  }
  if (manifest.bundle_id !== EXPECTED_BUNDLE_ID) {
    throw new BundleVerificationError(
      `bundle_id is "${manifest.bundle_id}", expected "${EXPECTED_BUNDLE_ID}"`,
    );
  }
  if (manifest.bundle_sha256 !== EXPECTED_BUNDLE_SHA256) {
    throw new BundleVerificationError(
      `bundle_sha256 is ${manifest.bundle_sha256}, expected the pinned ${EXPECTED_BUNDLE_SHA256}`,
    );
  }
  // The check a string comparison cannot make: is that pin consistent with the manifest's
  // own contents? A coherently edited manifest fails HERE and nowhere else.
  const recomputed = computeBundleSha256(manifest);
  if (recomputed !== manifest.bundle_sha256) {
    throw new BundleVerificationError(
      `bundle_sha256 does not match the manifest it certifies — declared ${manifest.bundle_sha256}, ` +
        `recomputed ${recomputed}. The manifest was edited after it was signed.`,
    );
  }

  if (!Array.isArray(manifest.series) || manifest.series.length !== EXPECTED_FILE_COUNT) {
    throw new BundleVerificationError(
      `expected ${EXPECTED_FILE_COUNT} series, found ${manifest.series?.length ?? 0}`,
    );
  }

  const fetchStartMs = Date.parse(manifest.fetch_start);
  const evaluationStartMs = Date.parse(manifest.evaluation_start);
  const asOfExclusiveMs = Date.parse(manifest.as_of_exclusive);
  for (const [label, value] of [
    ['fetch_start', fetchStartMs],
    ['evaluation_start', evaluationStartMs],
    ['as_of_exclusive', asOfExclusiveMs],
  ] as const) {
    if (Number.isNaN(value)) throw new BundleVerificationError(`${label} is not a valid instant`);
  }

  const series = new Map<string, Candle[]>();
  let gapsSeen = 0;

  for (const entry of manifest.series) {
    const file = path.join(dir, entry.file);
    let payload: { bytes: Buffer; value: unknown };
    try {
      payload = readJson(file);
    } catch (err) {
      throw new BundleVerificationError(
        `cannot read ${entry.file} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const digest = sha256Hex(payload.bytes);
    if (digest !== entry.sha256) {
      throw new BundleVerificationError(
        `${entry.file} digest is ${digest}, manifest declares ${entry.sha256}`,
      );
    }

    const rows = payload.value as RawCandle[];
    if (!Array.isArray(rows)) {
      throw new BundleVerificationError(`${entry.file} is not an array of candles`);
    }
    if (rows.length !== entry.rows) {
      throw new BundleVerificationError(
        `${entry.file} holds ${rows.length} rows, manifest declares ${entry.rows}`,
      );
    }

    const stepMs = timeframeStepMs(entry.timeframe);
    const candles: Candle[] = [];
    let previousOpen = -Infinity;

    for (const row of rows) {
      const openTime = Number(row.t);
      // The producer stores the OPEN time; the close is the slot's last millisecond, the
      // same convention its own manifest reports in `first_close_time`/`last_close_time`.
      const closeTime = openTime + stepMs - 1;
      if (!isAdmissibleCandle(openTime, closeTime, fetchStartMs, asOfExclusiveMs)) {
        throw new BundleVerificationError(
          `${entry.file} holds an inadmissible candle at ${new Date(openTime).toISOString()} ` +
            `(open ${openTime}, close ${closeTime}, bounds [${fetchStartMs}, ${asOfExclusiveMs}))`,
        );
      }
      if (openTime <= previousOpen) {
        throw new BundleVerificationError(
          `${entry.file} is not strictly ordered at ${new Date(openTime).toISOString()}`,
        );
      }
      previousOpen = openTime;
      candles.push({
        timestamp: openTime,
        open: Number(row.o),
        high: Number(row.h),
        low: Number(row.l),
        close: Number(row.c),
        volume: Number(row.v),
      });
    }

    const firstOpen = candles[0]?.timestamp;
    const lastOpen = candles[candles.length - 1]?.timestamp;
    if (firstOpen == null || lastOpen == null) {
      throw new BundleVerificationError(`${entry.file} is empty`);
    }
    if (new Date(firstOpen).toISOString() !== entry.first_open_time) {
      throw new BundleVerificationError(
        `${entry.file} starts at ${new Date(firstOpen).toISOString()}, manifest declares ${entry.first_open_time}`,
      );
    }
    if (new Date(lastOpen).toISOString() !== entry.last_open_time) {
      throw new BundleVerificationError(
        `${entry.file} ends at ${new Date(lastOpen).toISOString()}, manifest declares ${entry.last_open_time}`,
      );
    }

    // The hole, asserted where it belongs: on the 4h grid, never on the daily one.
    if (entry.timeframe === '4h') {
      const gap = entry.gaps.find(
        (g) =>
          g.afterOpenTime === EXPECTED_GAP.afterOpenTime &&
          g.beforeOpenTime === EXPECTED_GAP.beforeOpenTime &&
          g.missingBars === EXPECTED_GAP.missingBars,
      );
      if (!gap) {
        throw new BundleVerificationError(
          `${entry.file} no longer declares the Binance outage of 19/02/2020 — a bundle that ` +
            'grew the bar back is a different bundle, and it was never allowed to be filled',
        );
      }
      // Declared is not the same as present. Check the series really skips that slot.
      const filled = candles.some(
        (c) => c.timestamp === Date.parse(EXPECTED_GAP.afterOpenTime) + stepMs,
      );
      if (filled) {
        throw new BundleVerificationError(
          `${entry.file} declares the 19/02/2020 outage but carries a candle in it — filled or interpolated`,
        );
      }
      gapsSeen += 1;
    }

    series.set(`${entry.symbol}:${entry.timeframe}`, candles);
  }

  if (gapsSeen !== 4) {
    throw new BundleVerificationError(
      `expected the 19/02/2020 outage on all four 4h series, verified it on ${gapsSeen}`,
    );
  }

  return { manifest, series, fetchStartMs, evaluationStartMs, asOfExclusiveMs };
}

/** Milliseconds per bar. Local to the bundle's own vocabulary (`1d` / `4h`). */
function timeframeStepMs(timeframe: string): number {
  if (timeframe === '4h') return 4 * 60 * 60 * 1000;
  if (timeframe === '1d') return 24 * 60 * 60 * 1000;
  throw new BundleVerificationError(`unsupported timeframe "${timeframe}"`);
}
