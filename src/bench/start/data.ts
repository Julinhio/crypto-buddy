import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildDailyTable, type DailyTable } from '../exit/daily.js';
import { certifySealedPart, loadSealedFingerprint, mergeUniverses } from '../exit/sealed.js';
import type { BenchCandle } from '../exposure/bundle.js';
import { buildBenchConfig, type BenchConfig } from '../exposure/config.js';
import { assertProductionUniverse, buildTape, calibrationUniverse, productionUniverses, universeOfParts, type Tape } from '../exposure/tape.js';
import { SEAL_INSTANT_MS } from '../exposure/windows.js';

/**
 * THE DATA OF THE START-CONDITIONS STUDY — every candle S4 has ever been measured on, plus the
 * closed candles since, all read from the repository. Offline: nothing here touches a database,
 * and the network is reached by `refreshLive` only, on request.
 *
 * Three parts, in order:
 *
 *   1. the calibration bundles `[2020-01-01, 2024-07-01)` — certified against their pinned
 *      manifests, as every bench run does;
 *   2. the validation bundle `[2024-07-01, 2026-06-01)` — the part that stayed SEALED, outside every
 *      repository, until S4's validation opened it once (protocole de sortie v0.4, gel `f2cc048`).
 *      That window is consumed; the files are committed since 14/11/2026 so this study reruns from
 *      a clone. They are still certified byte for byte against the fingerprint committed BEFORE the
 *      opening — committing them changed nothing a hash can see;
 *   3. the closed public mainnet candles since 2026-05-20, from the bundles' own source
 *      (`data-api.binance.vision`), pinned by SHA-256 in `data/s4-start/live/manifest.json`. Their
 *      overlap with the sealed part must equal it field for field (`mergeUniverses`), which is what
 *      makes them the continuation of the same series rather than a lookalike.
 *
 * Having every candle in the repository does not make a new validation possible: all of it has
 * been seen. What is measured on it is a description.
 */

const DAY_MS = 86_400_000;
const H4_MS = 4 * 3_600_000;

export const SEALED_DIR = path.join('data', 'calibration', 'crypto-buddy-exposure-v2-validation');
export const LIVE_DIR = path.join('data', 's4-start', 'live');
export const LIVE_SOURCE = 'https://data-api.binance.vision';
/** Twelve days before the sealed part ends: the overlap the merge checks candle for candle. */
export const LIVE_FROM_MS = Date.parse('2026-05-20T00:00:00Z');

interface LiveRow {
  t: number; o: number; h: number; l: number; c: number; v: number;
  closeTime: number; qv: number; trades: number; takerBuyBase: number; takerBuyQuote: number;
}

export interface LiveManifest {
  kind: 's4-start-live-candles';
  source: string;
  from: string;
  /** Every candle in the files had CLOSED by this instant, a 4h boundary. */
  as_of_exclusive: string;
  files_sha256: Record<string, string>;
}

export interface StudyData {
  tape: Tape;
  table: DailyTable;
  cfg: BenchConfig;
  /** The end of the data: the 4h boundary by which every candle used had closed. */
  asOfMs: number;
  sealedEndMs: number;
  sources: Record<string, unknown>;
}

const toCandle = (r: LiveRow): BenchCandle => ({
  timestamp: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v,
  quoteVolume: r.qv, trades: r.trades, takerBuyQuote: r.takerBuyQuote,
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const liveFile = (asset: string, tf: '1d' | '4h'): string => `${asset}USDT-${tf}.json`;

/** Reads, certifies and merges the three parts. Throws on any mismatch — never a shorter series. */
export function loadStudyData(rootDir = process.cwd()): StudyData {
  const fp = loadSealedFingerprint(rootDir);
  const sealedEndMs = Date.parse(fp.as_of_exclusive);
  const calSealed = mergeUniverses(
    calibrationUniverse(rootDir, SEAL_INSTANT_MS),
    universeOfParts([certifySealedPart(fp, path.resolve(rootDir, SEALED_DIR))], sealedEndMs),
    SEAL_INSTANT_MS,
  );
  assertProductionUniverse(calSealed);

  const manifest = JSON.parse(readFileSync(path.resolve(rootDir, LIVE_DIR, 'manifest.json'), 'utf8')) as LiveManifest;
  if (manifest.kind !== 's4-start-live-candles') throw new Error('start study: not a live-candles manifest');
  const asOfMs = Date.parse(manifest.as_of_exclusive);
  if (!(asOfMs % H4_MS === 0) || !(asOfMs > sealedEndMs)) throw new Error(`start study: the live horizon ${manifest.as_of_exclusive} is not a 4h boundary after the sealed part`);
  const live: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  for (const asset of Object.keys(calSealed).sort()) {
    live[asset] = { daily: [], h4: [] };
    for (const [tf, key, step] of [['1d', 'daily', DAY_MS], ['4h', 'h4', H4_MS]] as const) {
      const name = liveFile(asset, tf);
      const text = readFileSync(path.resolve(rootDir, LIVE_DIR, name), 'utf8');
      if (sha256(text) !== manifest.files_sha256[name]) throw new Error(`start study: ${name} is not the file its manifest pins`);
      const rows = JSON.parse(text) as LiveRow[];
      const open = rows.find((r) => r.t + step > asOfMs);
      if (open) throw new Error(`start study: ${name} carries a candle not closed by ${manifest.as_of_exclusive}`);
      live[asset]![key] = rows.map(toCandle);
    }
  }
  // The overlap before the sealed end must be the certified candles, field for field.
  const full = mergeUniverses(calSealed, live, sealedEndMs);
  const tape = buildTape(full, productionUniverses().tradable, asOfMs);
  const cfg = buildBenchConfig();
  return {
    tape,
    table: buildDailyTable(tape, cfg.basket),
    cfg,
    asOfMs,
    sealedEndMs,
    sources: {
      calibration: 'data/calibration (certified core + SOL bundles), [2020-01-01, 2024-07-01)',
      validation: { dir: SEALED_DIR.replace(/\\/g, '/'), bundle_id: fp.bundle_id, bundle_sha256: fp.bundle_sha256, manifest_sha256: fp.manifest_sha256 },
      live: { dir: LIVE_DIR.replace(/\\/g, '/'), source: manifest.source, from: manifest.from, as_of_exclusive: manifest.as_of_exclusive, files_sha256: manifest.files_sha256 },
    },
  };
}

async function fetchKlines(symbol: string, tf: '1d' | '4h', untilMs: number): Promise<LiveRow[]> {
  const step = tf === '1d' ? DAY_MS : H4_MS;
  const rows: LiveRow[] = [];
  let start = LIVE_FROM_MS;
  for (;;) {
    const url = `${LIVE_SOURCE}/api/v3/klines?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const k = (await res.json()) as Array<[number, string, string, string, string, string, number, string, number, string, string]>;
    if (k.length === 0) break;
    for (const a of k) {
      if (a[0] + step > untilMs) continue; // not closed by the horizon
      rows.push({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], closeTime: a[6], qv: +a[7], trades: a[8], takerBuyBase: +a[9], takerBuyQuote: +a[10] });
    }
    if (k.length < 1000) break;
    start = k[k.length - 1]![0] + step;
  }
  return rows;
}

/**
 * Downloads the closed candles since 2026-05-20 up to `asOfMs` (a 4h boundary) and pins them.
 * The ONLY network access of the study, and only public market data. Run on request
 * (`--refresh`); a normal run reads what is committed.
 */
export async function refreshLive(asOfMs: number, rootDir = process.cwd()): Promise<LiveManifest> {
  if (!(asOfMs % H4_MS === 0)) throw new Error('start study: the horizon must be a 4h boundary');
  const dir = path.resolve(rootDir, LIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const asset of productionUniverses().regime) {
    for (const tf of ['1d', '4h'] as const) {
      const rows = await fetchKlines(`${asset}USDT`, tf, asOfMs);
      const text = `${JSON.stringify(rows)}\n`;
      writeFileSync(path.join(dir, liveFile(asset, tf)), text);
      files[liveFile(asset, tf)] = sha256(text);
    }
  }
  const manifest: LiveManifest = {
    kind: 's4-start-live-candles',
    source: LIVE_SOURCE,
    from: new Date(LIVE_FROM_MS).toISOString(),
    as_of_exclusive: new Date(asOfMs).toISOString(),
    files_sha256: files,
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
