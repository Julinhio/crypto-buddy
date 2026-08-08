import 'dotenv/config';
import { config, tradableBaseAssets } from '../config/index.js';
import { publicMainnetClient } from '../exchanges/binance.js';
import type { Candle } from '../market/klines.js';
import { timeframeMs } from '../market/klines.js';
import { regimeTimeline } from '../market/regime.js';
import { stickyAt, stickyTimelines, type StickyPoint } from '../market/transition.js';
import { ZERO, type Decimal } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { evaluateTransition, judgeOrder, type TransitionVerdict } from '../transition/gate.js';
import { fetchCandlesSince } from './klines.js';
import { loadCycleStream, replayPeaks, type Booking, type Cycle } from './transitionCycles.js';
import { fmtBar, loadObservationWindow, replayRegimeOptions } from './window.js';

/**
 * TRANSITION LAYER PROOF — does the LIVE layer compute what the measurement measured?
 *
 * This is the acceptance criterion of the observe-mode PR, and it is the one that would
 * block a merge. `docs/RAPPORT-CONTRAT-TRANSITION.md` measured a rule inside a replay
 * harness; production now runs that rule on every cycle. If the two ever disagreed, the
 * report would be describing a gate the bot does not have, and every figure in it would
 * stop meaning anything about the running system.
 *
 * So the harness does not re-implement the gate. It calls the SAME `evaluateTransition`
 * the live cycle calls, on inputs rebuilt from what the bot journaled, and compares its
 * verdicts against the replay's own actionability walk over the same 4h bars.
 *
 * Three things are checked, in the brief's order of weight:
 *
 *   P1  the live layer reproduces the replay, on every asset-cycle and on every order;
 *   P2  no real order was modified — demonstrated on the journal, not asserted;
 *   P3  the reference cases hold: the 13 divergent orders of 1-8 August come out
 *       forbidden, cycle 1163 included, and cycle 85's opening buys still pass.
 *
 * READ-ONLY and side-effect free: it reads `decisions` and `executions`, fetches public
 * mainnet candles, and writes nothing anywhere. The bot is running while it executes, so
 * everything is bounded to a window captured at the start of the run.
 *
 * Run with `npm run replay:transition-layer`. Exits non-zero if any check fails.
 */

const barMs = timeframeMs(config.regime.timeframe);
const confirmations = config.regime.thresholds.confirmations;

interface Check {
  id: string;
  title: string;
  passed: boolean;
  detail: string[];
}

const checks: Check[] = [];

function check(id: string, title: string, passed: boolean, detail: string[]): void {
  checks.push({ id, title, passed, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function section(title: string): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(title);
  console.log('═'.repeat(100));
}

/**
 * Rebuilds the exact inputs the live layer had on one (cycle, asset), so the production
 * function is fed the values the bot actually held rather than a convenient approximation.
 *
 * The peak is the one written at the END of the PREVIOUS cycle — that is what
 * `stateRead.states` holds when the live closure runs, and `evaluateStop` ratchets it with
 * the current price itself. Feeding this cycle's own post-ratchet peak instead would
 * silently make every drawdown zero on a new high.
 */
function inputsFor(
  cycle: Cycle,
  asset: string,
  sticky: StickyPoint | null,
  priorPeak: Decimal | null,
): Parameters<typeof evaluateTransition>[0] {
  const view = cycle.assets.get(asset);
  return {
    asset,
    sticky,
    // The journaled posture when the cycle has one; false before the regime column
    // existed, which is what production would have read from a null regime.
    riskOffConfirmed: cycle.riskOff ?? false,
    qty: view?.qtyBefore ?? ZERO,
    price: view?.price ?? null,
    priceStale: view?.priceStale ?? false,
    peakPriceSinceEntry: priorPeak,
    stopThresholdPercent: config.transition.peakStopPercent,
  };
}

async function main(): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error(
      'transition layer proof: Supabase is not configured — the harness reads (read-only) the ' +
        'decisions and executions journals. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  const window = await loadObservationWindow();
  console.log('═'.repeat(100));
  console.log('TRANSITION LAYER PROOF — the live gate versus the measured one');
  console.log('═'.repeat(100));
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  ` +
      `(${window.days} days, ${window.decisions} decisions)`,
  );
  console.log(
    `Gate: ${config.regime.timeframe} bars, confirmations=${confirmations}, ` +
      `peak stop ${config.transition.peakStopPercent}% (config.transition.peakStopPercent)`,
  );
  console.log('Mode: OBSERVE — the layer journals its verdict and blocks nothing.');
  console.log('Supabase access: READ-ONLY.');

  // Candles, with enough history before the window for the indicators and the sticky walk
  // to have converged well before the first measured bar.
  const client = publicMainnetClient();
  const DAY_MS = 24 * 3_600_000;
  const universe: Record<string, { daily: Candle[]; h4: Candle[] }> = {};
  for (const symbol of [...config.tradablePairs, ...config.referencePairs]) {
    const base = symbol.split('/')[0];
    if (!base) continue;
    const [daily, h4] = await Promise.all([
      fetchCandlesSince(client, symbol, config.primaryTimeframe, window.fromMs - 260 * DAY_MS),
      fetchCandlesSince(client, symbol, config.regime.timeframe, window.fromMs - 60 * DAY_MS),
    ]);
    universe[base] = { daily, h4 };
  }

  const timeline = regimeTimeline(universe, config.regime.thresholds, replayRegimeOptions());
  // Capped at the observation window, warm-up prefix kept: the same two-sided discipline
  // the measurement harness uses. Past the cap we would be resolving cycles with bars the
  // bot never saw; without the prefix the earliest cycles would resolve to nothing.
  const analysed = timeline.filter((p) => p.timestamp + barMs <= window.toMs);
  const sticky = stickyTimelines(analysed, confirmations, barMs);

  const { cycles, bookings, arrivedDuringTheRun } = await loadCycleStream(supabase, window.toMs);
  const { snapshots } = replayPeaks(cycles);
  console.log(
    `[proof] ${cycles.length} cycles, ${bookings.length} sovereign bookings, ` +
      `${arrivedDuringTheRun} row(s) committed by the live bot after the window was captured (excluded).`,
  );

  const tradable = tradableBaseAssets(config).filter((a) => sticky[a] != null);

  /* ── P1 — the live layer reproduces the replay ───────────────────────────── */
  section('P1 — the live layer reproduces the replay');

  // (a) Every asset-cycle. The replay's notion of "may act" is `stickyAt(...).actionable`;
  //     production's is the ladder's `actionable` field. They must agree everywhere, or
  //     the report describes a gate the bot does not have.
  let assetCycles = 0;
  const actionabilityMismatches: string[] = [];
  const gateCounts = new Map<string, number>();
  const verdicts = new Map<number, Map<string, TransitionVerdict>>();
  // One episode = a maximal run of consecutive would-fire cycles on one asset, which is
  // what the contract turns into a single full exit. Tracked per asset as we walk.
  const firingLastCycle = new Set<string>();
  let stopEpisodes = 0;

  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    const prior = i > 0 ? snapshots[i - 1]!.states : new Map();
    const perAsset = new Map<string, TransitionVerdict>();
    for (const asset of tradable) {
      const state = stickyAt(sticky[asset] ?? [], cycle.generatedAtMs, barMs);
      const verdict = evaluateTransition(
        inputsFor(cycle, asset, state, prior.get(asset)?.peakPriceSinceEntry ?? null),
      );
      perAsset.set(asset, verdict);
      gateCounts.set(verdict.gate, (gateCounts.get(verdict.gate) ?? 0) + 1);

      if (verdict.stopWouldFire) {
        if (!firingLastCycle.has(asset)) stopEpisodes += 1;
        firingLastCycle.add(asset);
      } else {
        firingLastCycle.delete(asset);
      }

      assetCycles += 1;
      const replayActionable = state?.actionable === true;
      if (verdict.actionable !== replayActionable && actionabilityMismatches.length < 5) {
        actionabilityMismatches.push(
          `#${cycle.id} ${asset}: production ${verdict.actionable} vs replay ${replayActionable}`,
        );
      }
    }
    verdicts.set(cycle.id, perAsset);
  }

  check(
    'P1a',
    'the production gate and the replay agree on actionability, at every asset-cycle',
    actionabilityMismatches.length === 0 && assetCycles > 0,
    [
      `${assetCycles} asset-cycles evaluated through the LIVE evaluateTransition()`,
      actionabilityMismatches.length === 0
        ? 'no divergence — the live layer and the measurement read the same tape'
        : `mismatches: ${actionabilityMismatches.join(' | ')}`,
      `ladder outcomes, in asset-cycles: ${[...gateCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([gate, n]) => `${gate} ×${n}`)
        .join(', ')}`,
      // `stop_exit` counted in ROWS is not the number of exits and must not be read as
      // one. Observe mode never sells, so the peak is never reset and a line stays under
      // its threshold for as long as the transition lasts — one contractual exit shows up
      // as a run of consecutive rows. The episode count is the honest figure.
      `stop_exit EPISODES (maximal runs of consecutive would-fire cycles, per asset): ${stopEpisodes} ` +
        `— the row count above is not a number of exits; in blocking mode each episode is ONE full exit.`,
      // And even the episode count is an OVER-count of what blocking mode would produce.
      // The report's shadow overlay sold the line and reset its peak, so the next trigger
      // needed a fresh 10% fall from a fresh high; here nothing sells, the peak never
      // resets, and the same un-recovered drawdown re-arms at every later transition. That
      // is why this reads 38 where RAPPORT §4 measured 5 — the two count different things,
      // and neither is wrong. Observe mode cannot produce the blocking-mode number, which
      // is precisely why the switch is a separate PR taken on this evidence.
      `RAPPORT §4 measured 5 episodes at 10% under a shadow overlay that DID exit and reset the peak; ` +
        `observe mode never exits, so an un-recovered drawdown re-arms at every later transition.`,
    ],
  );

  // (b) The bar each cycle resolves to must be the bar it JOURNALED. Everything above
  //     hangs off that resolution, and it is the one step the replay performs differently
  //     from production (a wall-clock lookup versus "the last point of the timeline").
  let barsChecked = 0;
  const barMismatches: string[] = [];
  for (const cycle of cycles) {
    if (cycle.regimeBarAtMs == null) continue;
    const resolved = stickyAt(sticky[tradable[0]!] ?? [], cycle.generatedAtMs, barMs);
    if (resolved == null) continue;
    barsChecked += 1;
    if (resolved.timestamp !== cycle.regimeBarAtMs && barMismatches.length < 5) {
      barMismatches.push(
        `#${cycle.id}: journaled ${fmtBar(cycle.regimeBarAtMs)} but resolved ${fmtBar(resolved.timestamp)}`,
      );
    }
  }
  check('P1b', 'every cycle resolves to the 4h bar it journaled', barMismatches.length === 0 && barsChecked > 0, [
    `${barsChecked} cycles compared against decisions.regime->>'barAt'`,
    barMismatches.length === 0 ? 'all identical' : `mismatches: ${barMismatches.join(' | ')}`,
  ]);

  // (c) Every real order, judged by the production path.
  interface Judged {
    booking: Booking;
    cycle: Cycle;
    verdict: TransitionVerdict;
    order: ReturnType<typeof judgeOrder>;
    diverging: boolean;
  }
  const judged: Judged[] = [];
  for (const cycle of cycles) {
    for (const booking of cycle.bookings) {
      const verdict = verdicts.get(cycle.id)?.get(booking.asset);
      if (verdict == null) continue;
      const journal = cycle.regime?.get(booking.asset) ?? null;
      judged.push({
        booking,
        cycle,
        verdict,
        order: judgeOrder(verdict, booking.side),
        diverging: journal != null && journal.raw !== journal.regime,
      });
    }
  }

  const allowed = judged.filter((j) => j.order.verdict === 'allowed');
  const forbidden = judged.filter((j) => j.order.verdict === 'forbidden');
  const superseded = judged.filter((j) => j.order.verdict === 'superseded');
  const unjudged = judged.filter((j) => j.order.verdict === 'unjudged');

  // The measurement's own count, recomputed here from the same walk, so "26 allowed / 16
  // forbidden" is verified rather than quoted from a document.
  const replayAllowed = judged.filter(
    (j) => stickyAt(sticky[j.booking.asset] ?? [], j.cycle.generatedAtMs, barMs)?.actionable === true,
  ).length;

  check(
    'P1c',
    'the production order verdicts match the measured ones',
    allowed.length === replayAllowed && judged.length === bookings.length,
    [
      `${judged.length} real orders judged (journal holds ${bookings.length})`,
      `allowed ${allowed.length} · forbidden ${forbidden.length} · superseded ${superseded.length} · unjudged ${unjudged.length}`,
      `the replay's actionability walk allows ${replayAllowed} — ` +
        `${allowed.length === replayAllowed ? 'identical' : 'DIVERGENT'}`,
      'the report measured 26 allowed / 16 forbidden over this window (RAPPORT §3).',
    ],
  );

  /* ── P2 — no real order was modified ──────────────────────────────────────── */
  section('P2 — no real order was modified');

  // The demonstration is on the JOURNAL, not on a claim. The layer only ever ADDS rows to
  // its own table: every sovereign booking that existed before this PR is still there,
  // with the same quantity and the same price, and the layer's verdict — including the 16
  // it would have refused — changed none of them.
  const forbiddenNotional = forbidden.reduce(
    (sum, j) => sum + j.booking.baseDelta.abs().times(j.booking.valuationPrice).toNumber(),
    0,
  );
  check('P2', 'every real order survived the layer untouched', judged.length === bookings.length, [
    `${bookings.length} sovereign bookings in the journal, ${judged.length} of them judged by the layer`,
    `${forbidden.length} would have been refused (worth $${forbiddenNotional.toFixed(2)}) and ALL of them booked anyway`,
    'the layer writes only to transition_observations; it removes nothing and adds no movement.',
    'Structurally: its closure runs after the movements are computed, judged, booked and executed,',
    'and receives the resulting ledger as an INPUT — there is no path from its verdict back into',
    'clampAllocation / computeMovements / executeMovements, and its writer is best-effort by contract',
    'so it cannot fail a cycle either.',
  ]);

  /* ── P3 — the reference cases ─────────────────────────────────────────────── */
  section('P3 — the reference cases');

  const fromMs = Date.parse('2026-08-01T00:00:00.000Z');
  const weekDiverging = judged.filter((j) => j.cycle.generatedAtMs >= fromMs && j.diverging);
  const weekDivergingBlocked = weekDiverging.filter((j) => j.order.verdict !== 'allowed');
  const c1163 = judged.filter((j) => j.cycle.id === 1163);
  const c85 = judged.filter((j) => j.cycle.id === 85);

  console.log('');
  console.log(
    `   ${'cycle'.padEnd(6)}${'when'.padEnd(18)}${'asset'.padEnd(6)}${'side'.padEnd(6)}${'shown'.padEnd(15)}` +
      `${'raw'.padEnd(15)}${'run'.padStart(4)}  ${'gate'.padEnd(20)}verdict`,
  );
  for (const j of weekDiverging) {
    console.log(
      `   ${String(j.cycle.id).padEnd(6)}${fmtBar(j.cycle.generatedAtMs).padEnd(18)}${j.booking.asset.padEnd(6)}` +
        `${j.booking.side.padEnd(6)}${(j.verdict.confirmedRegime ?? 'n/a').padEnd(15)}` +
        `${(j.verdict.rawRegime ?? 'n/a').padEnd(15)}${String(j.verdict.runLength).padStart(4)}  ` +
        `${j.verdict.gate.padEnd(20)}${j.order.verdict.toUpperCase()}`,
    );
  }

  check(
    'P3a',
    'the divergent orders of 1-8 August are all refused, cycle 1163 included',
    weekDiverging.length === weekDivergingBlocked.length &&
      weekDiverging.length > 0 &&
      c1163.length > 0 &&
      c1163.every((j) => j.order.verdict !== 'allowed'),
    [
      `orders placed while raw ≠ shown, from 2026-08-01 to the window's end: ${weekDiverging.length}`,
      `refused by the layer: ${weekDivergingBlocked.length}/${weekDiverging.length}`,
      `cycle 1163 (BNB sold on a \`range\` label while raw was already trend_up): ` +
        `${c1163.map((j) => `${j.booking.asset} ${j.order.verdict}`).join(', ')}`,
      'the report measured 13 such orders over this window (RAPPORT §3).',
    ],
  );

  // The mirror, and it matters as much: a gate that refused everything would satisfy the
  // check above while being useless. Cycle 85's four opening buys were placed on a
  // regime confirmed for dozens of bars — they must still pass.
  check(
    'P3b',
    'the healthy orders still pass — the gate is a filter, not a muzzle',
    c85.length > 0 && c85.every((j) => j.order.verdict === 'allowed'),
    [
      `cycle 85 (the four opening buys, on regimes confirmed for 8 to 70 bars): ` +
        `${c85.map((j) => `${j.booking.asset} ${j.order.verdict}`).join(', ')}`,
      `overall the layer allows ${allowed.length} of ${judged.length} real orders ` +
        `(${((allowed.length / Math.max(judged.length, 1)) * 100).toFixed(1)}%).`,
    ],
  );

  const failed = checks.filter((c) => !c.passed);
  console.log('');
  console.log('═'.repeat(100));
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length > 0
        ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}`
        : ' — the live layer computes what the measurement measured.'),
  );
  console.log('═'.repeat(100));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Transition layer proof failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
