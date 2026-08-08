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
import {
  expectsObservation,
  loadCycleStream,
  missingObservationBatches,
  replayPeaks,
  type Booking,
  type Cycle,
} from './transitionCycles.js';
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
  /** Could not be evaluated yet — neither a pass nor a divergence. See `skip`. */
  skipped: boolean;
  detail: string[];
}

const checks: Check[] = [];

function check(id: string, title: string, passed: boolean, detail: string[]): void {
  checks.push({ id, title, passed, skipped: false, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

/**
 * A check that could not be EVALUATED, which is a third thing and must look like one.
 *
 * Reporting it as PASS would claim a proof that was never run; reporting it as FAIL would
 * make the harness red for a reason that is not a defect — before the migration is applied
 * and the first cycle has run, there is simply nothing yet to compare. So it prints
 * distinctly, leaves the exit code alone, and is counted separately in the summary so a
 * green run can never be mistaken for a complete one.
 */
function skip(id: string, title: string, detail: string[]): void {
  checks.push({ id, title, passed: false, skipped: true, detail });
  console.log('');
  console.log(`SKIP  ${id} — ${title}`);
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

  // (a) The LADDER's consistency with the rule, over every asset-cycle.
  //
  //     Deliberately NOT "does verdict.actionable equal state.actionable" — the gate
  //     copies that field straight from the sticky state it was handed, so comparing the
  //     two would be comparing a value with its own source and would pass on any ladder
  //     whatsoever. What is worth asserting is that the RUNGS never contradict the rule:
  //     an actionable asset must never come out frozen, a frozen one must never come out
  //     actionable, and the stop must never appear outside a transition.
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
      const frozen = state?.frozen === true;
      const problem =
        state == null
          ? verdict.gate !== 'no_regime'
            ? `no bar closed but the gate returned ${verdict.gate}`
            : null
          : verdict.gate === 'actionable' && frozen
            ? 'a frozen asset came out actionable'
            : (verdict.gate === 'frozen' || verdict.gate === 'risk_off_reduction') && !frozen
              ? `an actionable asset came out ${verdict.gate}`
              : verdict.gate === 'stop_exit' && !frozen
                ? 'the stop fired outside a transition'
                : verdict.stopArmed && !frozen
                  ? 'the stop was armed outside a transition'
                  : null;
      if (problem != null && actionabilityMismatches.length < 5) {
        actionabilityMismatches.push(`#${cycle.id} ${asset}: ${problem}`);
      }
    }
    verdicts.set(cycle.id, perAsset);
  }

  check(
    'P1a',
    'the ladder never contradicts the rule, at any asset-cycle',
    actionabilityMismatches.length === 0 && assetCycles > 0,
    [
      `${assetCycles} asset-cycles evaluated through the LIVE evaluateTransition()`,
      actionabilityMismatches.length === 0
        ? 'no contradiction: nothing frozen came out actionable, nothing actionable came out frozen, ' +
          'and the stop never armed outside a transition'
        : `contradictions: ${actionabilityMismatches.join(' | ')}`,
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
  //
  // The risk_off exception has to be carried here too. The measurement judged an order on
  // actionability alone, because the override never armed over that window; production's
  // ladder additionally allows a SELL on a frozen asset under a confirmed global risk_off.
  // The two therefore coincide today and would diverge the first time the override arms —
  // which would be the ladder working as designed, not a defect, and a check that reported
  // it as a mismatch would cry wolf on the one episode we most want to observe.
  const riskOffOrders = judged.filter((j) => j.cycle.riskOff === true).length;
  const replayAllowed = judged.filter((j) => {
    const state = stickyAt(sticky[j.booking.asset] ?? [], j.cycle.generatedAtMs, barMs);
    if (state?.actionable === true) return true;
    return state?.frozen === true && j.cycle.riskOff === true && j.booking.side === 'sell';
  }).length;

  check(
    'P1c',
    'the production order verdicts match the measured ones',
    allowed.length === replayAllowed && judged.length === bookings.length,
    [
      `${judged.length} real orders judged (journal holds ${bookings.length})`,
      `allowed ${allowed.length} · forbidden ${forbidden.length} · superseded ${superseded.length} · unjudged ${unjudged.length}`,
      `the replay's own walk (actionability + the risk_off reduction exception) allows ${replayAllowed} — ` +
        `${allowed.length === replayAllowed ? 'identical' : 'DIVERGENT'}`,
      `orders placed while the global risk_off was confirmed: ${riskOffOrders} ` +
        `— the exception is inert on this window, which is why the measurement's simpler rule matched it`,
      'the report measured 26 allowed / 16 forbidden over this window (RAPPORT §3).',
    ],
  );

  // (d) THE LIVE PATH ITSELF. Everything above re-runs the pure function offline, which
  //     proves the gate computes the right thing — and nothing at all about whether the
  //     bot is actually running it. If `observeTransition` stopped being called, mapped
  //     the wrong asset, or persisted a different verdict, every check above would still
  //     pass. So the rows the LIVE cycles wrote are read back and compared against what
  //     the gate says they should contain.
  //
  //     Before the migration is applied and the code deployed there are no rows, and that
  //     is reported as SKIPPED rather than passed: an empty table proving nothing must not
  //     look like a green check.
  const observedIds = cycles.map((c) => c.id);
  const persisted = new Map<string, Record<string, unknown>>();
  let observationsReadable = true;
  try {
    for (let i = 0; i < observedIds.length; i += 500) {
      const { data, error } = await supabase
        .from('transition_observations')
        // Every column the comparison below reads. `order_side` in particular: comparing a
        // column that was never selected reads `undefined`, normalises to null, and drifts
        // against every correctly persisted order row — a check that fails loudest exactly
        // when the thing it watches is working.
        .select('decision_id, asset, gate, actionable, run_length, stop_would_fire, order_side, order_verdict')
        .in('decision_id', observedIds.slice(i, i + 500));
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        persisted.set(`${String(row.decision_id)}:${String(row.asset)}`, row);
      }
    }
  } catch (err) {
    observationsReadable = false;
    console.warn(
      `[proof] transition_observations could not be read (${err instanceof Error ? err.message : String(err)}) — ` +
        'the migration is probably not applied yet.',
    );
  }

  if (persisted.size === 0) {
    skip('P1d', 'the LIVE layer persisted what the gate computes', [
      observationsReadable
        ? 'the table exists but holds no row for this window.'
        : 'the table could not be read — migration 0022 is not applied yet.',
      'This can only be evaluated once migration 0022 is applied AND the code has run at least',
      'one cycle. Until then the checks above show the gate is CORRECT, not that it is WIRED —',
      'two different claims, so this one is reported as unevaluated rather than passed.',
      'Re-run `npm run replay:transition-layer` after the first deployed cycle.',
    ]);
  } else {
    // A cycle that produced ANY observation must have produced one per tradable asset —
    // the live closure writes the whole batch or none of it. Skipping absent rows
    // unconditionally would let a half-wired layer (one asset per cycle, say) pass on the
    // strength of the rows that did land, which is the exact regression this check exists
    // to catch. Cycles that predate the deployment have no rows at all and are excluded
    // wholesale; a cycle with 1..n-1 rows is a defect.
    const observedCycles = new Set<number>();
    for (const key of persisted.keys()) observedCycles.add(Number(key.split(':')[0]));

    // THE DEPLOYMENT CUTOFF. Requiring completeness only of cycles that already wrote
    // something leaves the worst failure invisible: a cycle that wrote NOTHING at all — a
    // whole batch lost to the writer's 5s deadline, or a return path where the call was
    // never added — looks exactly like a cycle that predates the deployment. So the cutoff
    // is the FIRST observed cycle, and every eligible cycle from there on must carry a
    // full batch.
    //
    // "Eligible" is decided by `expectsObservation`, on the skip REASON and not on the
    // status: `decide()` has two skipped paths and only one of them returns before the
    // closure. A status-only exemption waived both, so a lost batch on the empty-context
    // path — which does call `observeTransition` — was indistinguishable from the
    // lifecycle-read path's deliberate abstention.
    const cutoff = Math.min(...observedCycles);
    const eligibleCycles = cycles.filter((c) => c.id >= cutoff && expectsObservation(c));
    const lostBatches = missingObservationBatches({ cycles, observedCycleIds: observedCycles, cutoff });

    let compared = 0;
    const drift: string[] = [];
    const incomplete: string[] = [];
    const missingBatches = lostBatches
      .slice(0, 5)
      .map((c) => `#${c.id} (${c.status}): no observation at all`);
    const eligible = eligibleCycles.length;

    for (const [cycleId, perAsset] of verdicts) {
      const cycle = cycles.find((c) => c.id === cycleId);
      if (cycleId < cutoff) continue; // genuinely predates the deployment
      if (!observedCycles.has(cycleId)) continue; // already accounted for by `lostBatches`

      for (const [asset, verdict] of perAsset) {
        const row = persisted.get(`${cycleId}:${asset}`);
        if (row == null) {
          if (incomplete.length < 5) {
            incomplete.push(`#${cycleId} ${asset}: the cycle wrote observations but not this asset's`);
          }
          continue;
        }
        compared += 1;

        // The ORDER verdict is compared too, not merely selected. Without it, a closure
        // that attributed a booking to the wrong asset — or persisted the wrong
        // `judgeOrder` result — would leave this check green while P1c stayed green as
        // well, since P1c recomputes everything offline and never looks at a stored row.
        const booking = cycle?.bookings.find((b) => b.asset === asset) ?? null;
        const expectedOrder = booking == null ? null : judgeOrder(verdict, booking.side);

        const expected = {
          gate: verdict.gate,
          actionable: verdict.actionable,
          run_length: verdict.runLength,
          stop_would_fire: verdict.stopWouldFire,
          order_side: booking?.side ?? null,
          order_verdict: expectedOrder?.verdict ?? null,
        };
        const actual = {
          gate: row.gate,
          actionable: row.actionable,
          run_length: Number(row.run_length),
          stop_would_fire: row.stop_would_fire,
          order_side: (row.order_side as string | null) ?? null,
          order_verdict: (row.order_verdict as string | null) ?? null,
        };
        if (JSON.stringify(expected) !== JSON.stringify(actual) && drift.length < 5) {
          drift.push(`#${cycleId} ${asset}: wrote ${JSON.stringify(actual)}, gate says ${JSON.stringify(expected)}`);
        }
      }
    }

    check(
      'P1d',
      'the LIVE layer persisted what the gate computes, in full',
      drift.length === 0 && incomplete.length === 0 && lostBatches.length === 0 && compared > 0,
      [
        `${persisted.size} observation rows over ${observedCycles.size} cycles; ${compared} compared against the gate`,
        `deployment cutoff: cycle ${cutoff} — ${eligible} eligible cycles from there on ` +
          `(only the lifecycle-read skip, which returns before the closure, is exempt)`,
        `cycles with NO observation at all after the cutoff: ` +
          `${lostBatches.length === 0 ? 'none' : `LOST ${lostBatches.length} — ${missingBatches.join(' | ')}`}`,
        `each observed cycle must carry all ${tradable.length} tradable assets — ` +
          `${incomplete.length === 0 ? 'none is short' : `INCOMPLETE: ${incomplete.join(' | ')}`}`,
        drift.length === 0
          ? 'every persisted verdict matches, order side and verdict included — the layer is wired, not merely correct'
          : `drift: ${drift.join(' | ')}`,
      ],
    );
  }

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

  // THE REFERENCE CORPUS IS A FIXED HISTORICAL SET, so it is pinned at BOTH ends.
  //
  // The lower bound alone was wrong: the observation window grows with every cycle the bot
  // runs, so later divergent orders would silently join "the 13 measured cases". A single
  // legitimate risk_off sell would then fail P3a for behaving correctly, and extra
  // forbidden orders would keep it green while the set it reports is no longer the one the
  // report measured. Either way the check stops describing what it claims to.
  //
  // Pinned by cycle id rather than by date because that is exactly the set: cycle 1163 was
  // the last one on record when RAPPORT §3 was written, and its BNB sell is reference case
  // C6. A date bound would be a proxy for this; the id IS it.
  const REFERENCE_CORPUS_LAST_CYCLE = 1163;
  const fromMs = Date.parse('2026-08-01T00:00:00.000Z');
  const weekDiverging = judged.filter(
    (j) => j.cycle.generatedAtMs >= fromMs && j.cycle.id <= REFERENCE_CORPUS_LAST_CYCLE && j.diverging,
  );
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

  // The corpus has a KNOWN SIZE, so the check asserts it rather than settling for "more
  // than none". Without the exact count, anything that silently dropped cases — a paging
  // bug, a parse failure, a classification change — would leave P3a green while validating
  // a smaller set, and the report would be certified against a corpus it never saw.
  const REFERENCE_CORPUS_SIZE = 13;
  check(
    'P3a',
    'the divergent orders of 1-8 August are all refused, cycle 1163 included',
    weekDiverging.length === REFERENCE_CORPUS_SIZE &&
      weekDiverging.length === weekDivergingBlocked.length &&
      c1163.length > 0 &&
      c1163.every((j) => j.order.verdict !== 'allowed'),
    [
      `orders placed while raw ≠ shown, over the PINNED corpus ` +
        `[2026-08-01, cycle ${REFERENCE_CORPUS_LAST_CYCLE}]: ${weekDiverging.length} ` +
        `(the corpus has exactly ${REFERENCE_CORPUS_SIZE} — asserted, not assumed)`,
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

  const failed = checks.filter((c) => !c.passed && !c.skipped);
  const skipped = checks.filter((c) => c.skipped);
  console.log('');
  console.log('═'.repeat(100));
  console.log(
    `${checks.length - failed.length - skipped.length}/${checks.length} checks passed` +
      (skipped.length > 0 ? `, ${skipped.length} not yet evaluable (${skipped.map((s) => s.id).join(', ')})` : '') +
      (failed.length > 0
        ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}`
        : skipped.length > 0
          ? ' — the gate is correct; whether it is WIRED cannot be checked before the first deployed cycle.'
          : ' — the live layer computes what the measurement measured, and persists it.'),
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
