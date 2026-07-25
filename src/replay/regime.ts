import 'dotenv/config';
import { config, type RegimeThresholds } from '../config/index.js';
import {
  REGIME_VERSION,
  effectiveRegime,
  regimeTimeline,
  resolveRegimes,
  type AssetRegime,
  type AssetSeries,
  type RegimePoint,
} from '../market/regime.js';
import { sliceEndingAt } from './klines.js';
import { fmtBar, loadObservationWindow, loadUniverseSeries, pct } from './window.js';

/**
 * REGIME REPLAY — the acceptance criteria of Strategy V2 PR 1.
 *
 * The mandate is explicit that the replay is not a final brick but a CRITERION: we do
 * not validate a regime calculator after building everything that rests on it. So
 * this harness re-runs the DETERMINISTIC layer over the window the bot actually
 * observed and checks, one by one, the claims the PR makes.
 *
 * What is replayed: the code's regime, on real public-mainnet candles.
 * What is NOT replayed: the model's decisions. Re-running Sonnet 787 times is
 * expensive, non-deterministic, and a backtest cannot honestly answer "would the
 * model have taken its profits".
 *
 * Read-only and side-effect free: it reads `decisions` to learn the window, fetches
 * public candles, and writes nothing anywhere.
 *
 * Run with `npm run replay:regime`. Exits non-zero if any criterion fails.
 */

interface Criterion {
  id: string;
  title: string;
  passed: boolean;
  detail: string[];
}

const results: Criterion[] = [];

function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, title, passed, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

/** Counts label transitions in a series (the first bar is a state, not a change). */
function countChanges<T>(values: T[]): number {
  let changes = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1]) changes += 1;
  }
  return changes;
}

/** `trend_up ×12, range ×5` — a distribution, most frequent first. */
function distribution(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} ×${n}`)
    .join(', ');
}

function assetsOf(points: RegimePoint[]): string[] {
  return points.length > 0 ? Object.keys(points[0]!.assets) : [];
}

/** The effective label per bar for one asset — what the system would act on. */
function effectiveSeries(points: RegimePoint[], asset: string): string[] {
  return points.map((p) => effectiveRegime(p, asset) ?? 'n/a');
}

function closeSeries(points: RegimePoint[], asset: string): number[] {
  return points.map((p) => p.assets[asset]?.signals.close ?? NaN);
}

/* ────────────────────────────────────────────────────────────────────────────
 * C1 — ETH's climb off its low is NOT read as risk_off.
 *
 * The failure being corrected is precise: the model STAYED on `risk_off` while ETH
 * gained 27% off its low. So the criterion is about the characterization of the
 * climb, not about a single bar.
 *
 * It deliberately does NOT demand zero risk_off bars. The window starts at the exact
 * low tick, and at that instant the tape genuinely was risk-off — 80%+ of the universe
 * under both daily averages with weak momentum. A causal classifier cannot know a
 * bottom is a bottom while it is printing one; requiring otherwise would be testing
 * for clairvoyance instead of for the defect. What it demands instead is stricter on
 * everything that matters:
 *
 *   (a) risk_off is marginal — under 5% of the climb;
 *   (b) it is confined to before the turn — no risk_off bar once a constructive label
 *       has appeared, i.e. the override never comes BACK during the advance;
 *   (c) constructive labels are the majority of the climb;
 *   (d) `trend_up` is actually reached — the trend playbook has to be reachable during
 *       a +25% advance. This one is a permanent regression guard: the first run of this
 *       harness produced zero trend_up bars here, which is how the SMA50-slope defect
 *       was found.
 * ──────────────────────────────────────────────────────────────────────────── */
function criterionEthClimb(points: RegimePoint[]): void {
  const closes = closeSeries(points, 'ETH');
  let lowIdx = 0;
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i]! < closes[lowIdx]!) lowIdx = i;
  }
  let highIdx = lowIdx;
  for (let i = lowIdx; i < closes.length; i += 1) {
    if (closes[i]! > closes[highIdx]!) highIdx = i;
  }

  const climb = points.slice(lowIdx, highIdx + 1);
  const labels = effectiveSeries(climb, 'ETH');
  const isConstructive = (l: string): boolean => l === 'trend_up' || l === 'reversal_up';

  const riskOffBars = labels.filter((l) => l === 'risk_off').length;
  const constructive = labels.filter(isConstructive).length;
  const trendUpBars = labels.filter((l) => l === 'trend_up').length;
  const firstConstructive = labels.findIndex(isConstructive);
  const riskOffAfterTurn =
    firstConstructive < 0 ? riskOffBars : labels.slice(firstConstructive).filter((l) => l === 'risk_off').length;
  const gain = ((closes[highIdx]! - closes[lowIdx]!) / closes[lowIdx]!) * 100;
  const riskOffShare = (riskOffBars / labels.length) * 100;

  record(
    'C1',
    'ETH is not characterized as risk_off during its climb off the low',
    riskOffShare < 5 && riskOffAfterTurn === 0 && constructive > labels.length / 2 && trendUpBars > 0,
    [
      `climb: ${fmtBar(climb[0]!.timestamp)} → ${fmtBar(climb[climb.length - 1]!.timestamp)}  ` +
        `${closes[lowIdx]!.toFixed(2)} → ${closes[highIdx]!.toFixed(2)}  (${pct(gain)}, ${climb.length} bars)`,
      `regimes over the climb: ${distribution(labels)}`,
      `(a) risk_off share: ${riskOffBars}/${labels.length} bars (${riskOffShare.toFixed(1)}%, bound < 5%)`,
      `(b) risk_off bars after the first constructive label (bar ${firstConstructive}, ` +
        `${firstConstructive >= 0 ? fmtBar(climb[firstConstructive]!.timestamp) : 'never'}): ` +
        `${riskOffAfterTurn} (bound 0 — the override never returns during the advance)`,
      `(c) constructive (trend_up + reversal_up): ${constructive}/${labels.length} ` +
        `(${((constructive / labels.length) * 100).toFixed(0)}%, bound > 50%)`,
      `(d) trend_up bars: ${trendUpBars} (bound > 0 — the trend playbook is reachable)`,
    ],
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * C2 — ETH and BNB do not carry the same label while one rises and the other falls.
 *
 * The reason the regime is per-asset at all. A single global label would reproduce
 * today's blindness in deterministic form.
 * ──────────────────────────────────────────────────────────────────────────── */
function criterionEthBnbDivergence(points: RegimePoint[]): void {
  const eth = closeSeries(points, 'ETH');
  const bnb = closeSeries(points, 'BNB');
  const minBars = 30; // ≈ 5 days — long enough that the divergence is structural

  let best = { i: -1, j: -1, spread: 0 };
  for (let i = 0; i + minBars < points.length; i += 1) {
    for (let j = i + minBars; j < points.length; j += 1) {
      const ethRet = (eth[j]! - eth[i]!) / eth[i]!;
      const bnbRet = (bnb[j]! - bnb[i]!) / bnb[i]!;
      if (ethRet <= 0 || bnbRet >= 0) continue;
      const spread = ethRet - bnbRet;
      if (spread > best.spread) best = { i, j, spread };
    }
  }

  if (best.i < 0) {
    record('C2', 'ETH and BNB carry different labels while one rises and the other falls', false, [
      'no window found where ETH rises and BNB falls — cannot evaluate.',
    ]);
    return;
  }

  const slice = points.slice(best.i, best.j + 1);
  const ethLabels = effectiveSeries(slice, 'ETH');
  const bnbLabels = effectiveSeries(slice, 'BNB');
  let differing = 0;
  for (let k = 0; k < slice.length; k += 1) if (ethLabels[k] !== bnbLabels[k]) differing += 1;
  const ethRet = ((eth[best.j]! - eth[best.i]!) / eth[best.i]!) * 100;
  const bnbRet = ((bnb[best.j]! - bnb[best.i]!) / bnb[best.i]!) * 100;

  record(
    'C2',
    'ETH and BNB carry different labels while one rises and the other falls',
    differing > 0,
    [
      `most divergent window: ${fmtBar(slice[0]!.timestamp)} → ${fmtBar(slice[slice.length - 1]!.timestamp)} ` +
        `(${slice.length} bars)`,
      `ETH ${eth[best.i]!.toFixed(2)} → ${eth[best.j]!.toFixed(2)} (${pct(ethRet)})  |  ` +
        `BNB ${bnb[best.i]!.toFixed(2)} → ${bnb[best.j]!.toFixed(2)} (${pct(bnbRet)})`,
      `ETH regimes: ${distribution(ethLabels)}`,
      `BNB regimes: ${distribution(bnbLabels)}`,
      `bars where the two labels differ: ${differing}/${slice.length} ` +
        `(${((differing / slice.length) * 100).toFixed(0)}%)`,
    ],
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * C3 — the global risk_off override takes priority over the per-asset regimes.
 *
 * Proven on REAL bars, not on a hand-built object: the timeline is recomputed with a
 * deliberately permissive risk_off threshold so the override actually arms on the
 * observed data, and we then check that every asset's effective regime is risk_off on
 * those bars WHILE their own directional regimes stay varied. That is what
 * "prioritaire, pas une catégorie concurrente" means: the per-asset structure is not
 * erased, it is overridden.
 * ──────────────────────────────────────────────────────────────────────────── */
function criterionRiskOffPriority(
  points: RegimePoint[],
  universe: Record<string, AssetSeries>,
  windowFrom: number,
  windowTo: number,
): void {
  const detail: string[] = [];
  const liveRiskOff = points.filter((p) => p.global.riskOff).length;
  detail.push(
    `production thresholds (breadth ≥ ${config.regime.thresholds.riskOffBreadthPercent}%, ` +
      `median 4h RSI < ${config.regime.thresholds.riskOffMedianH4Rsi}): ` +
      `${liveRiskOff}/${points.length} bars in risk_off.`,
  );

  // A permissive posture, used ONLY to exercise the override on real candles.
  const permissive: RegimeThresholds = {
    ...config.regime.thresholds,
    riskOffBreadthPercent: 40,
    riskOffMedianH4Rsi: 55,
  };
  const forced = regimeTimeline(universe, permissive).filter(
    (p) => p.timestamp >= windowFrom && p.timestamp <= windowTo,
  );
  const armed = forced.filter((p) => p.global.riskOff);
  detail.push(
    `permissive thresholds (breadth ≥ 40%, median 4h RSI < 55), used only to arm the ` +
      `override on real bars: ${armed.length}/${forced.length} bars in risk_off.`,
  );

  if (armed.length === 0) {
    record('C3', 'the global risk_off override takes priority over the per-asset regimes', false, [
      ...detail,
      'the override never armed, even permissively — priority could not be exercised on real data.',
    ]);
    return;
  }

  let overriddenAssetBars = 0;
  let leaks = 0;
  const underlying = new Set<AssetRegime>();
  for (const p of armed) {
    for (const [asset, entry] of Object.entries(p.assets)) {
      overriddenAssetBars += 1;
      underlying.add(entry.regime);
      if (effectiveRegime(p, asset) !== 'risk_off') leaks += 1;
    }
  }

  // The mirror property: with the override off, the effective regime IS the asset's own.
  let mismatchesWhenOff = 0;
  for (const p of forced.filter((x) => !x.global.riskOff)) {
    for (const [asset, entry] of Object.entries(p.assets)) {
      if (effectiveRegime(p, asset) !== entry.regime) mismatchesWhenOff += 1;
    }
  }

  detail.push(
    `while armed: ${overriddenAssetBars} asset-bars, all effective = risk_off (${leaks} leak(s)).`,
    `their own directional regimes underneath stayed varied: ${[...underlying].sort().join(', ')} ` +
      `— overridden, not erased.`,
    `while disarmed: ${mismatchesWhenOff} asset-bar(s) where the effective regime differed from the asset's own.`,
  );

  record(
    'C3',
    'the global risk_off override takes priority over the per-asset regimes',
    leaks === 0 && mismatchesWhenOff === 0 && underlying.size > 1,
    detail,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * C4 — hysteresis keeps the regime from flipping at every 4h candle.
 *
 * The bound is stated up front rather than read off the result: at most one regime
 * change per 24h on average (one per 6 bars). Anything looser and we would have
 * replaced immobility with noise, which the mandate names as the failure mode.
 * ──────────────────────────────────────────────────────────────────────────── */
function criterionHysteresis(points: RegimePoint[]): void {
  const bars = points.length;
  const maxChanges = Math.floor(bars / 6);
  const detail: string[] = [
    `${bars} 4h bars replayed  ·  confirmations = ${config.regime.thresholds.confirmations} ` +
      `(${config.regime.thresholds.confirmations * 4}h of agreement before a flip)`,
    `bound checked: ≤ ${maxChanges} stabilized changes per asset (one per 24h on average)`,
  ];

  let allWithinBound = true;
  let allReduced = true;
  for (const asset of assetsOf(points)) {
    const raw = points.map((p) => p.assets[asset]!.raw);
    const stable = points.map((p) => p.assets[asset]!.regime);
    const rawChanges = countChanges(raw);
    const stableChanges = countChanges(stable);
    if (stableChanges > maxChanges) allWithinBound = false;
    if (stableChanges >= rawChanges) allReduced = false;
    const meanHold = stableChanges > 0 ? ((bars / (stableChanges + 1)) * 4) / 24 : bars / 6;
    detail.push(
      `${asset.padEnd(4, ' ')} raw ${String(rawChanges).padStart(3, ' ')} changes  →  ` +
        `stabilized ${String(stableChanges).padStart(3, ' ')}  ` +
        `(${((1 - stableChanges / Math.max(rawChanges, 1)) * 100).toFixed(0)}% removed, ` +
        `mean hold ≈ ${meanHold.toFixed(1)} days)`,
    );
  }

  const globalRaw = countChanges(points.map((p) => p.global.raw));
  const globalStable = countChanges(points.map((p) => p.global.riskOff));
  detail.push(`risk_off  raw ${globalRaw} changes  →  stabilized ${globalStable}`);

  record('C4', 'hysteresis bounds the number of regime changes', allWithinBound && allReduced, detail);
}

/* ────────────────────────────────────────────────────────────────────────────
 * C5 — the replay reproduces production, it does not approximate it.
 *
 * Production only ever holds `config.regime.limit` 4h candles; the harness walks a
 * much longer series. The hysteresis walk must converge to the same state either way,
 * otherwise every number above would describe a calculator the bot does not run. So
 * we recompute the final point from a production-sized slice and require an exact
 * match — the criterion that makes the other four mean anything.
 * ──────────────────────────────────────────────────────────────────────────── */
function criterionProductionEquivalence(
  points: RegimePoint[],
  universe: Record<string, AssetSeries>,
): void {
  const last = points[points.length - 1];
  if (!last) {
    record('C5', 'the replay reproduces what production computes', false, ['empty timeline.']);
    return;
  }

  const productionSized: Record<string, AssetSeries> = {};
  for (const [asset, series] of Object.entries(universe)) {
    productionSized[asset] = {
      daily: sliceEndingAt(series.daily, last.timestamp, config.primaryLimit),
      h4: sliceEndingAt(series.h4, last.timestamp, config.regime.limit),
    };
  }
  const asProduction = resolveRegimes(productionSized, config.regime.thresholds);

  const detail: string[] = [
    `bar compared: ${fmtBar(last.timestamp)}  ·  production window = ` +
      `${config.regime.limit} × ${config.regime.timeframe} + ${config.primaryLimit} × ${config.primaryTimeframe}`,
  ];
  let identical = asProduction != null && asProduction.timestamp === last.timestamp;
  if (asProduction) {
    if (asProduction.global.riskOff !== last.global.riskOff) identical = false;
    for (const asset of assetsOf(points)) {
      const a = last.assets[asset]!.regime;
      const b = asProduction.assets[asset]?.regime;
      if (a !== b) identical = false;
      detail.push(`${asset.padEnd(4, ' ')} full series ${a.padEnd(14, ' ')} production slice ${b ?? 'n/a'}`);
    }
    detail.push(
      `risk_off  full series ${last.global.riskOff}  production slice ${asProduction.global.riskOff}`,
    );
  }
  record('C5', 'the replay reproduces what production computes', identical, detail);
}

/** One line per calendar day at 00:00 UTC — the regime seen at a glance. */
function printTimeline(points: RegimePoint[]): void {
  const assets = assetsOf(points);
  console.log('');
  console.log('─ Daily sample of the regime timeline (00:00 UTC bars) '.padEnd(96, '─'));
  console.log(`   ${'date'.padEnd(12, ' ')}${assets.map((a) => a.padEnd(15, ' ')).join('')}risk_off`);
  for (const p of points) {
    if (new Date(p.timestamp).getUTCHours() !== 0) continue;
    const cells = assets.map((a) => (p.assets[a]?.regime ?? 'n/a').padEnd(15, ' ')).join('');
    console.log(`   ${fmtBar(p.timestamp).slice(0, 10).padEnd(12, ' ')}${cells}${p.global.riskOff ? 'ON' : '·'}`);
  }
}

async function main(): Promise<number> {
  const window = await loadObservationWindow();
  console.log('='.repeat(96));
  console.log(`REGIME REPLAY — version ${REGIME_VERSION}`);
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  ` +
      `(${window.days} days, ${window.decisions} decisions)`,
  );
  console.log(
    `Thresholds: confirmations=${config.regime.thresholds.confirmations}, ` +
      `h4 RSI up/down=${config.regime.thresholds.h4RsiUp}/${config.regime.thresholds.h4RsiDown}, ` +
      `range pos low/high=${config.regime.thresholds.lowRangePosition}/${config.regime.thresholds.highRangePosition}, ` +
      `risk_off breadth=${config.regime.thresholds.riskOffBreadthPercent}% & median 4h RSI<${config.regime.thresholds.riskOffMedianH4Rsi}`,
  );
  console.log('='.repeat(96));

  const universe = await loadUniverseSeries(window);
  const full = regimeTimeline(universe, config.regime.thresholds);
  const points = full.filter((p) => p.timestamp >= window.fromMs && p.timestamp <= window.toMs);
  if (points.length === 0) throw new Error('replay: no 4h bar inside the observation window.');

  printTimeline(points);

  criterionEthClimb(points);
  criterionEthBnbDivergence(points);
  criterionRiskOffPriority(points, universe, window.fromMs, window.toMs);
  criterionHysteresis(points);
  criterionProductionEquivalence(points, universe);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log('='.repeat(96));
  console.log(
    `${results.length - failed.length}/${results.length} criteria passed` +
      (failed.length > 0 ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ' — all PR 1 acceptance criteria met.'),
  );
  console.log('='.repeat(96));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Regime replay failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
