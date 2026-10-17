import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Candle } from '../../market/klines.js';
import {
  BundleVerificationError,
  computeBundleSha256,
  isAdmissibleCandle,
  sha256Hex,
  type BundleManifest,
} from '../../calibration/exposure/bundle.js';
import { SEAL_INSTANT_MS } from './windows.js';

/**
 * THE CALIBRATION GATE OF BENCH v1.3 — the bundle v2 parts, certified, and nothing sealed.
 *
 * The certification itself is the PR #36 one, reused rather than rewritten: the pinned
 * `bundle_sha256` is RECOMPUTED from the manifest's own preimage, every file is hashed, every
 * row is re-judged against the admissibility rule. What is new is the SEAL:
 *
 *   no candle that OPENS (or closes) at or after 2024-07-01 may pass this function.
 *
 * It is checked twice, on purpose. First on the manifest's declared horizon, before a single
 * candle file is opened: a bundle that SAYS it reaches into the sealed window is refused
 * without reading it. Then row by row, because a manifest is a claim, and a file appended
 * after signing would still have to break the per-file digest — the row check is what makes
 * that a second, independent line rather than a single one.
 *
 * There is no flag to lift it. The validation window will be read by a different command,
 * from a directory outside the repository, against the committed fingerprint.
 */

export class SealViolationError extends Error {
  constructor(message: string) {
    super(`sealed window refused: ${message}`);
    this.name = 'SealViolationError';
  }
}

/** One bundle part this bench accepts, pinned in code. */
export interface BundlePin {
  dir: string;
  bundleId: string;
  bundleSha256: string;
  /** Symbols × timeframes the part must carry, exactly. */
  series: readonly string[];
}

export const CORE_PIN: BundlePin = Object.freeze({
  dir: path.join('data', 'calibration', 'crypto-buddy-exposure-v2-core'),
  bundleId: 'crypto-buddy-exposure-v2-core',
  bundleSha256: '1ec86eba76046eca8fc27906d2f7e513a3b3cbce5fcde32facd9d1e258cb6ad2',
  series: Object.freeze(
    ['BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT'].flatMap((s) => [`${s}:1d`, `${s}:4h`]),
  ),
});

export const SOL_PIN: BundlePin = Object.freeze({
  dir: path.join('data', 'calibration', 'crypto-buddy-exposure-v2-sol'),
  bundleId: 'crypto-buddy-exposure-v2-sol',
  bundleSha256: 'a1eee621bf9941a8acd7f0a7bf5b171477747bc19fa6e01f96b25e3f600415e5',
  series: Object.freeze(['SOLUSDT:1d', 'SOLUSDT:4h']),
});

/** A candle plus the flow fields the SCORE components may read. */
export interface BenchCandle extends Candle {
  quoteVolume: number;
  trades: number;
  takerBuyQuote: number;
}

export interface CertifiedPart {
  manifest: BundleManifest;
  /** Candles per `SYMBOL:timeframe`. */
  series: Map<string, BenchCandle[]>;
}

interface RawCandle {
  t: number;
  o: string | number;
  h: string | number;
  l: string | number;
  c: string | number;
  v: string | number;
  closeTime: number;
  qv: string | number;
  trades: number;
  takerBuyQuote: string | number;
}

const STEP_MS: Record<string, number> = { '4h': 4 * 3_600_000, '1d': 86_400_000 };

/**
 * Loads and certifies ONE part. `rootDir` exists for the tests, which point it at synthetic
 * bundles — a sealed candle, a resealed manifest — without touching the real data.
 */
export function loadCertifiedPart(pin: BundlePin, rootDir = process.cwd()): CertifiedPart {
  const dir = path.resolve(rootDir, pin.dir);
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BundleManifest;
  } catch (err) {
    throw new BundleVerificationError(
      `cannot read ${pin.dir}/manifest.json (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // ── THE SEAL, ON THE CLAIM — before any candle file is opened ─────────────────────
  const asOfExclusiveMs = Date.parse(manifest.as_of_exclusive);
  if (!Number.isFinite(asOfExclusiveMs) || asOfExclusiveMs > SEAL_INSTANT_MS) {
    throw new SealViolationError(
      `${pin.bundleId} declares as_of_exclusive ${manifest.as_of_exclusive}, past the seal ` +
        `${new Date(SEAL_INSTANT_MS).toISOString()} — not read`,
    );
  }

  if (manifest.schema_version !== 1) {
    throw new BundleVerificationError(`${pin.bundleId}: schema_version ${manifest.schema_version}, expected 1`);
  }
  if (manifest.bundle_id !== pin.bundleId) {
    throw new BundleVerificationError(`bundle_id is "${manifest.bundle_id}", expected "${pin.bundleId}"`);
  }
  if (manifest.bundle_sha256 !== pin.bundleSha256) {
    throw new BundleVerificationError(
      `${pin.bundleId}: bundle_sha256 ${manifest.bundle_sha256}, pinned ${pin.bundleSha256}`,
    );
  }
  const recomputed = computeBundleSha256(manifest);
  if (recomputed !== manifest.bundle_sha256) {
    throw new BundleVerificationError(
      `${pin.bundleId}: bundle_sha256 does not match its own preimage (recomputed ${recomputed})`,
    );
  }
  const declared = manifest.series.map((s) => `${s.symbol}:${s.timeframe}`).sort();
  if (declared.join(',') !== [...pin.series].sort().join(',')) {
    throw new BundleVerificationError(
      `${pin.bundleId}: carries [${declared.join(', ')}], expected [${[...pin.series].sort().join(', ')}]`,
    );
  }

  const fetchStartMs = Date.parse(manifest.fetch_start);
  const series = new Map<string, BenchCandle[]>();

  for (const entry of manifest.series) {
    const stepMs = STEP_MS[entry.timeframe];
    if (stepMs == null) throw new BundleVerificationError(`unsupported timeframe "${entry.timeframe}"`);
    const bytes = readFileSync(path.join(dir, entry.file));
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256) {
      throw new BundleVerificationError(`${entry.file} digest is ${digest}, manifest declares ${entry.sha256}`);
    }
    const rows = JSON.parse(bytes.toString('utf8')) as RawCandle[];
    if (!Array.isArray(rows) || rows.length !== entry.rows) {
      throw new BundleVerificationError(`${entry.file}: ${Array.isArray(rows) ? rows.length : 'no'} rows, manifest declares ${entry.rows}`);
    }

    const candles: BenchCandle[] = [];
    let previous = -Infinity;
    const gaps: Array<{ afterOpenTime: string; beforeOpenTime: string; missingBars: number }> = [];
    for (const row of rows) {
      const openTime = Number(row.t);
      const closeTime = Number(row.closeTime);
      // ── THE SEAL, ON THE ROW ────────────────────────────────────────────────────
      if (openTime >= SEAL_INSTANT_MS || closeTime >= SEAL_INSTANT_MS) {
        throw new SealViolationError(
          `${entry.file} carries a candle opened ${new Date(openTime).toISOString()} — inside the sealed window`,
        );
      }
      // A close INSIDE its slot, never past it. Not "equal to the slot end": the 4h bar opened
      // 2020-02-19T08:00Z closes at 11:35:33Z on Binance — the outage cut it short — and that
      // is a fact the producer recorded, not a defect to refuse.
      if (!(closeTime > openTime && closeTime <= openTime + stepMs - 1)) {
        throw new BundleVerificationError(`${entry.file}: close ${closeTime} lies outside the slot of ${openTime}`);
      }
      if (!isAdmissibleCandle(openTime, closeTime, fetchStartMs, asOfExclusiveMs)) {
        throw new BundleVerificationError(`${entry.file}: inadmissible candle at ${new Date(openTime).toISOString()}`);
      }
      if (openTime <= previous) {
        throw new BundleVerificationError(`${entry.file}: not strictly ordered at ${new Date(openTime).toISOString()}`);
      }
      if (previous !== -Infinity && openTime - previous > stepMs) {
        gaps.push({
          afterOpenTime: new Date(previous).toISOString(),
          beforeOpenTime: new Date(openTime).toISOString(),
          missingBars: (openTime - previous) / stepMs - 1,
        });
      }
      previous = openTime;
      candles.push({
        timestamp: openTime,
        open: Number(row.o),
        high: Number(row.h),
        low: Number(row.l),
        close: Number(row.c),
        volume: Number(row.v),
        quoteVolume: Number(row.qv),
        trades: Number(row.trades),
        takerBuyQuote: Number(row.takerBuyQuote),
      });
    }
    // Holes are declared AND real, never filled. Recomputed from the rows, compared to the claim.
    if (JSON.stringify(gaps) !== JSON.stringify(entry.gaps)) {
      throw new BundleVerificationError(
        `${entry.file}: gaps recomputed ${JSON.stringify(gaps)}, manifest declares ${JSON.stringify(entry.gaps)}`,
      );
    }
    if (new Date(candles[0]!.timestamp).toISOString() !== entry.first_open_time ||
        new Date(candles[candles.length - 1]!.timestamp).toISOString() !== entry.last_open_time) {
      throw new BundleVerificationError(`${entry.file}: endpoints differ from the manifest`);
    }
    series.set(`${entry.symbol}:${entry.timeframe}`, candles);
  }

  return { manifest, series };
}
