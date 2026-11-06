import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDailyTable } from '../bench/exit/daily.js';
import { makeExitRule, type TrailingLine } from '../bench/exit/rules.js';
import { certifySealedPart, loadSealedFingerprint, mergeUniverses, sliceRun, trajectoryPrefixDivergence } from '../bench/exit/sealed.js';
import type { BenchCandle } from '../bench/exposure/bundle.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import { runWindow } from '../bench/exposure/engine.js';
import { T100 } from '../bench/exposure/policy.js';
import { assertProductionUniverse, buildTape, calibrationUniverse, firstPrefixDivergence, productionUniverses, universeOfParts, type Tape } from '../bench/exposure/tape.js';
import { EXIT_CONTINUOUS, EXIT_SEALED, SEAL_INSTANT_MS } from '../bench/exposure/windows.js';
import { computeMovements } from '../execution/movements.js';
import { Decimal, ZERO } from '../money.js';
import { derivePortfolio } from '../portfolio/derive.js';
import { plannerAllocation, s4Allocation, s4Gate, type S4Line } from './core.js';

/**
 * THE START OF S4 IN PRODUCTION, RECONSTRUCTED — read-only, run before the deployment.
 *
 * The bench starts S4 in the market at the head of a continuous trajectory (2020-10-01). It does
 * not say how to resume a live book in November 2026, and "start the four assets in market" would
 * NOT be S4. So the state is REPLAYED: the bench's own engine and S4 rule, on the certified
 * calibration and sealed bundles, extended with the closed public mainnet candles of the same
 * source (data-api.binance.vision), up to `asOf`. Trusted only if, first:
 *
 *   - the regime tape on the extended data equals the sealed tape on its whole prefix;
 *   - the extended trajectory equals the sealed one on its whole prefix;
 *   - it reproduces S4's published sealed capital, 1 101,50 $;
 *   - the final state does not depend on the start point (convergence over several starts).
 *
 * Usage: tsx src/s4/reconstruct.ts --sealed-dir <dir> [--as-of <ISO 4h boundary>] [--book <json>]
 * Writes out/s4/reconstruction.json and out/s4/live/*.json, prints the seed SQL.
 */

const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const LIVE_FROM = Date.parse('2026-05-20T00:00:00Z');
const SOURCE = 'https://data-api.binance.vision';
const OUT_DIR = path.join('out', 's4');
const CONVERGENCE_STARTS = ['2020-10-01', '2022-01-01', '2024-07-01', '2025-06-01', '2026-01-01', '2026-03-01'];

export interface ReconLine {
  asset: string;
  status: 'in' | 'out';
  entryAtMs: number | null;
  high: number | null;
  exitAtMs: number | null;
  armed: boolean;
  /** The bench's fill open at the entry, for the record (never read by the rule). */
  entryPrice: number | null;
  close: number;
  sma50: number;
}

export interface Reconstruction {
  kind: 's4-reconstruction';
  asOfMs: number;
  lastCloseMs: number;
  sources: Record<string, unknown>;
  checks: {
    regimePrefixDivergence: string | null;
    trajectoryPrefixDivergence: string | null;
    sealedCapital: number;
    convergence: Array<{ start: string; lines: Array<Pick<ReconLine, 'asset' | 'status' | 'high' | 'exitAtMs' | 'armed'>> }>;
  };
  lines: ReconLine[];
  bench: { equity: number; exposurePercent: number; weights: Record<string, number>; gates: Record<string, string> };
  initialPlan: null | {
    book: { equity: number; cash: number; weights: Record<string, number> };
    targets: Record<string, number>;
    legs: Array<{ asset: string; side: 'buy' | 'sell'; usd: number; fullExit: boolean }>;
  };
}

/** The seed of `s4_line_state`: the bench's lines, as production persists them. */
export function seedLinesOf(r: Reconstruction): S4Line[] {
  return r.lines.map((l) => ({
    asset: l.asset,
    status: l.status,
    entryAtMs: l.status === 'in' ? l.entryAtMs : null,
    high: l.status === 'in' ? l.high : null,
    exitAtMs: l.status === 'out' ? l.exitAtMs : null,
    armed: l.armed,
    entryPrice: l.status === 'in' ? l.entryPrice : null,
    lastMoveReason: 'reprise_etat_banc',
    lastMoveAtMs: r.asOfMs,
  }));
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function fetchLive(symbol: string, tf: '1d' | '4h', untilMs: number): Promise<unknown[]> {
  const step = tf === '1d' ? DAY : H4;
  const rows: unknown[] = [];
  let start = LIVE_FROM;
  for (;;) {
    const url = `${SOURCE}/api/v3/klines?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const k = (await res.json()) as Array<[number, string, string, string, string, string, number, string, number, string, string]>;
    if (k.length === 0) break;
    for (const a of k) {
      if (a[0] + step > untilMs) continue; // not closed by asOf
      rows.push({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], closeTime: a[6], qv: +a[7], trades: a[8], takerBuyBase: +a[9], takerBuyQuote: +a[10] });
    }
    if (k.length < 1000) break;
    start = k[k.length - 1]![0] + step;
  }
  return rows;
}

const toCandle = (r: Record<string, number>): BenchCandle => ({
  timestamp: r.t!, open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
  quoteVolume: Number(r.qv), trades: Number(r.trades), takerBuyQuote: Number(r.takerBuyQuote),
});

async function main(): Promise<void> {
  const root = process.cwd();
  const sealedDir = arg('--sealed-dir');
  if (!sealedDir) throw new Error('--sealed-dir <dir> is required (the sealed validation bundle)');
  const asOfArg = arg('--as-of');
  const asOfMs = asOfArg ? Date.parse(asOfArg) : Math.floor(Date.now() / H4) * H4;
  if (!(asOfMs % H4 === 0)) throw new Error('--as-of must be a 4h boundary');

  const fp = loadSealedFingerprint(root);
  const sealedEnd = Date.parse(fp.as_of_exclusive);
  const calSealed = mergeUniverses(calibrationUniverse(root, SEAL_INSTANT_MS), universeOfParts([certifySealedPart(fp, sealedDir)], sealedEnd), SEAL_INSTANT_MS);
  assertProductionUniverse(calSealed);

  mkdirSync(path.join(OUT_DIR, 'live'), { recursive: true });
  const live: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  const liveShas: Record<string, string> = {};
  for (const asset of Object.keys(calSealed).sort()) {
    live[asset] = { daily: [], h4: [] };
    for (const [tf, key] of [['1d', 'daily'], ['4h', 'h4']] as const) {
      const rows = await fetchLive(`${asset}USDT`, tf, asOfMs);
      const file = path.join(OUT_DIR, 'live', `${asset}USDT-${tf}.json`);
      const text = `${JSON.stringify(rows)}\n`;
      writeFileSync(file, text);
      liveShas[`${asset}USDT-${tf}`] = createHash('sha256').update(text).digest('hex');
      live[asset]![key] = (rows as Array<Record<string, number>>).map(toCandle);
    }
  }
  // The live overlap before the sealed end must be the certified candles, field for field.
  const full = mergeUniverses(calSealed, live, sealedEnd);
  const tradable = productionUniverses().tradable;
  const sealedTape = buildTape(calSealed, tradable, sealedEnd);
  const tape = buildTape(full, tradable, asOfMs);
  const cfg = buildBenchConfig();
  const sealedTable = buildDailyTable(sealedTape, cfg.basket);
  const table = buildDailyTable(tape, cfg.basket);

  const run = (t: Tape, tbl: typeof table, fromMs: number, toMs: number) => {
    const rule = makeExitRule('S4', tbl);
    const r = runWindow({ tape: t, cfg, policy: T100, window: { name: 'exit-continuous', fromMs, toMs }, exitRule: rule, unsafeSyntheticWindow: true });
    return { run: r, lines: (rule as unknown as { lines: Record<string, TrailingLine> }).lines };
  };
  const sealedRun = run(sealedTape, sealedTable, EXIT_CONTINUOUS.fromMs, sealedEnd);
  const main = run(tape, table, EXIT_CONTINUOUS.fromMs, asOfMs);
  const sealedCapital = Math.round(sliceRun(sealedRun.run, EXIT_SEALED, 1000).bars.at(-1)!.equity * 100) / 100;
  const regimePrefixDivergence = firstPrefixDivergence(sealedTape, tape);
  const trajPrefixDivergence = trajectoryPrefixDivergence(sealedRun.run, main.run, sealedEnd);
  if (sealedCapital !== 1101.5 || regimePrefixDivergence != null || trajPrefixDivergence != null) {
    throw new Error(`reconstruction refused: sealed capital ${sealedCapital}, regime prefix ${regimePrefixDivergence}, trajectory prefix ${trajPrefixDivergence}`);
  }

  const lastRow = table.rows[table.rows.length - 1]!;
  const last = main.run.bars.at(-1)!;
  const lines: ReconLine[] = cfg.assets.map((asset) => {
    const l = main.lines[asset]!;
    const pos = main.run.finalState.positions[asset];
    const entryBar = l.entryAtMs != null ? tape.tapes[asset]!.h4[tape.tapes[asset]!.indexByTs.get(l.entryAtMs)!] : undefined;
    if (l.status === 'in' && pos?.entryAtMs !== l.entryAtMs) throw new Error(`${asset}: the rule's entry is not the position's`);
    return {
      asset, status: l.status, entryAtMs: l.entryAtMs, high: l.high, exitAtMs: l.exitAtMs, armed: l.armed,
      entryPrice: entryBar?.open ?? null, close: lastRow.close[asset]!, sma50: lastRow.sma50[asset]!,
    };
  });
  const convergence = CONVERGENCE_STARTS.map((start) => {
    const r = run(tape, table, Date.parse(`${start}T00:00:00Z`), asOfMs);
    return { start, lines: cfg.assets.map((a) => ({ asset: a, status: r.lines[a]!.status, high: r.lines[a]!.high, exitAtMs: r.lines[a]!.exitAtMs, armed: r.lines[a]!.armed })) };
  });
  if (!convergence.every((c) => JSON.stringify(c.lines) === JSON.stringify(convergence[0]!.lines))) {
    throw new Error('reconstruction refused: the state depends on the start point');
  }

  // The initial orders, from a production book given as {cash, qty: {BTC: "…"}} — optional.
  let initialPlan: Reconstruction['initialPlan'] = null;
  const bookFile = arg('--book');
  if (bookFile) {
    const b = JSON.parse(readFileSync(bookFile, 'utf8')) as { startingCapital: number; ledger: Array<{ symbol: string; side: 'buy' | 'sell'; valuationPrice: string; baseDelta: string; quoteDelta: string }>; prices?: Record<string, number> };
    const lastBar = (a: string) => tape.tapes[a]!.h4[tape.tapes[a]!.indexByTs.get(last.t)!]!;
    const prices: Record<string, Decimal> = Object.fromEntries(cfg.assets.map((a) => [a, new Decimal(b.prices?.[a] ?? lastBar(a).close)]));
    const priceOf = (a: string) => (a === 'USDT' ? new Decimal(1) : prices[a] ?? null);
    const book = derivePortfolio(
      b.ledger.map((e) => ({ symbol: e.symbol, side: e.side, valuationPrice: new Decimal(e.valuationPrice), baseDelta: new Decimal(e.baseDelta), quoteDelta: new Decimal(e.quoteDelta) })),
      { startingCapital: new Decimal(b.startingCapital), reserveAsset: 'USDT', priceOf },
    );
    const weights = Object.fromEntries(cfg.assets.map((a) => {
      const p = book.positions.find((x) => x.asset === a);
      return [a, p ? p.value.div(book.equity).times(100).toNumber() : 0];
    }));
    const gates = Object.fromEntries(cfg.assets.map((a) => [a, s4Gate({ asset: a, sticky: tape.tapes[a]!.stickyByTs.get(last.t) ?? null, qty: book.positions.find((x) => x.asset === a)?.qty ?? ZERO, price: prices[a]!, priceStale: false, stopThresholdPercent: 10 })]));
    const out = new Set(lines.filter((l) => l.status === 'out').map((l) => l.asset));
    const { lines: plan } = s4Allocation({ assets: cfg.assets, basket: cfg.basket, caps: cfg.caps, out, gates, weights, priced: Object.fromEntries(cfg.assets.map((a) => [a, true])) });
    const allocation = plannerAllocation(plan, 'USDT');
    const legs = computeMovements(book, allocation, priceOf, 0.1, cfg.minMovementPercent);
    initialPlan = {
      book: { equity: book.equity.toNumber(), cash: book.cash.toNumber(), weights },
      targets: allocation,
      legs: legs.map((m) => ({ asset: m.asset, side: m.side, usd: Math.round(m.notional.toNumber() * 100) / 100, fullExit: m.fullExit === true })),
    };
  }

  const recon: Reconstruction = {
    kind: 's4-reconstruction',
    asOfMs,
    lastCloseMs: lastRow.closeMs,
    sources: {
      calibration: 'data/calibration (certified core + SOL bundles)',
      sealed: { bundle_id: fp.bundle_id, bundle_sha256: fp.bundle_sha256, manifest_sha256: fp.manifest_sha256 },
      live: { source: SOURCE, from: new Date(LIVE_FROM).toISOString(), closed_by: new Date(asOfMs).toISOString(), files_sha256: liveShas },
      engine: 'src/bench/exposure/engine.ts runWindow, policy T100, exit rule S4 (src/bench/exit/rules.ts)',
      trajectory_from: new Date(EXIT_CONTINUOUS.fromMs).toISOString(),
    },
    checks: { regimePrefixDivergence, trajectoryPrefixDivergence: trajPrefixDivergence, sealedCapital, convergence },
    lines,
    bench: { equity: last.equity, exposurePercent: last.exposurePercent, weights: last.weights, gates: last.gates },
    initialPlan,
  };
  writeFileSync(path.join(OUT_DIR, 'reconstruction.json'), `${JSON.stringify(recon, null, 2)}\n`);

  const iso = (v: number | null) => (v == null ? 'null' : `'${new Date(v).toISOString()}'`);
  const n = (v: number | null) => (v == null ? 'null' : String(v));
  const seed = seedLinesOf(recon);
  const seedSource = JSON.stringify({ kind: recon.kind, asOf: new Date(asOfMs).toISOString(), lastClose: new Date(recon.lastCloseMs).toISOString(), sources: recon.sources, checks: { sealedCapital, convergenceStarts: CONVERGENCE_STARTS } }).replace(/'/g, "''");
  const sql = [
    'begin;',
    // The breaker CLOSED: the first S4 cycle decides and journals but sends nothing, until the
    // operator has compared its planned legs with the frozen initial plan and opens it.
    `insert into public.s4_pilot (id, seed_source, last_close_at, orders_enabled) values (1, '${seedSource}'::jsonb, ${iso(recon.lastCloseMs)}, false);`,
    ...seed.map((l) => `insert into public.s4_line_state (asset, status, entry_at, entry_price, high, exit_at, days_out, armed, last_move_reason, last_move_at) values ('${l.asset}', '${l.status}', ${iso(l.entryAtMs)}, ${n(l.entryPrice)}, ${n(l.high)}, ${iso(l.exitAtMs)}, ${l.exitAtMs != null ? Math.floor((recon.lastCloseMs - l.exitAtMs) / DAY) : 'null'}, ${l.armed}, 'reprise_etat_banc', ${iso(recon.asOfMs)});`),
    'commit;',
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, 'seed.sql'), `${sql}\n`);

  console.log(`S4 reconstruction as of ${new Date(asOfMs).toISOString()} (last daily close ${new Date(recon.lastCloseMs).toISOString()})`);
  console.log(`checks: sealed capital ${sealedCapital} $, regime prefix ${regimePrefixDivergence ?? 'identical'}, trajectory prefix ${trajPrefixDivergence ?? 'identical'}, convergence over ${CONVERGENCE_STARTS.join(', ')}`);
  for (const l of lines) {
    console.log(`  ${l.asset}: ${l.status}` + (l.status === 'in'
      ? ` since ${new Date(l.entryAtMs!).toISOString().slice(0, 10)}, high ${l.high}, exit under ${(l.high! * 0.8).toFixed(4)}`
      : ` since ${new Date(l.exitAtMs!).toISOString().slice(0, 10)}, armed ${l.armed}`) + `, close ${l.close}, sma50 ${l.sma50.toFixed(4)}`);
  }
  if (initialPlan) for (const leg of initialPlan.legs) console.log(`  initial: ${leg.side} ${leg.asset} ${leg.usd} $${leg.fullExit ? ' (full exit)' : ''}`);
  console.log(`\nwrote ${OUT_DIR}/reconstruction.json and ${OUT_DIR}/seed.sql`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
