import { config, tradableBaseAssets } from '../config/index.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import type { HoldingView } from '../bench/exposure/engine.js';
import { buildMarketContext, marketHealthOf, type MarketContext } from '../context/build.js';
import { buildPriceLookup } from '../decision/context.js';
import type { DecideResult, SeenMarket } from '../decision/decide.js';
import { getGitSha } from '../decision/gitSha.js';
import { reserveStables } from '../decision/schema.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { emptyExecutionSummary, executeMovements, type ExecutionSummary } from '../execution/execute.js';
import { computeMovements, movementFloor, type Movement } from '../execution/movements.js';
import { timeframeMs } from '../market/klines.js';
import { recordMarketDataOutage } from '../market/outage.js';
import { dec, ZERO } from '../money.js';
import { nextPositionStates } from '../portfolio/lifecycle.js';
import { derivePortfolio, type VirtualPortfolio } from '../portfolio/derive.js';
import { insertDecision, type DecisionRow } from '../persistence/decisions.js';
import { loadLedger } from '../persistence/executions.js';
import { loadPositionStates, savePositionStates } from '../persistence/positionState.js';
import {
  commitCloses,
  linkCloseDecisions,
  markBlockedCloseAlerted,
  markPilotStarted,
  readS4State,
  saveLines,
  setPending,
} from '../persistence/s4State.js';
import { loadStartingCapital } from '../persistence/startingCapital.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { sendTelegram } from '../alerting/telegram.js';
import {
  applyDailyCloses,
  dueCloses,
  missingClose,
  nextCycleDelayMinutes,
  plannerAllocation,
  readDailyTable,
  reconcileEntries,
  s4Allocation,
  s4Gate,
  type S4CloseEvent,
  type S4Line,
  type S4LinePlan,
  type S4MoveReason,
  type S4PendingExecution,
} from './core.js';

/**
 * ONE S4 CYCLE — the only path to the orders since 06/11/2026.
 *
 *   1. read the market (prices, 4h regime and its sticky walk, daily candles), the book, the S4
 *      state;
 *   2. THE STATE DECISION — every daily close not yet consumed, oldest first, run through the
 *      bench's S4 step and committed in ONE transaction with the journal and the last close
 *      (conditioned on the last close read: a close is consumed once, ever). A due close that is
 *      missing or not closed blocks the cycle: no decision, no order, an alert, a retry at the
 *      next wake-up;
 *   3. THE EXECUTION ENGINE — the bench's line states and allocation at this 4h cycle, the
 *      plumbing floor and the drift rebalancing in production's `planMovements`;
 *   4. the decision row, then the orders (unless the breaker `orders_enabled` is off), then the
 *      entries the fills opened or closed.
 *
 * NO MODEL ANYWHERE ON THIS PATH. The explanation sent to Telegram is written after the cycle,
 * outside its timeout, from the facts this report carries (`beat.ts`).
 */

export const S4_PROMPT_VERSION = 's4-v1';
/** Minutes after each 4h boundary at which the next cycle is due — lets the bar close and land. */
export const S4_CYCLE_OFFSET_MINUTES = 3;
/** Retry delay after a blocked or skipped cycle: the next beat. */
export const S4_RETRY_DELAY_MINUTES = 5;

const DAY_MS = 86_400_000;

export interface S4Movement {
  asset: string;
  side: 'buy' | 'sell';
  usd: number;
  reason: S4MoveReason;
}

export interface S4Report {
  label: string;
  ordersEnabled: boolean;
  firstCycle: boolean;
  closesDecided: number[];
  events: S4CloseEvent[];
  lines: S4Line[];
  plan: S4LinePlan[];
  movements: S4Movement[];
  /** Planned legs the breaker kept from being sent (orders disabled). */
  withheld: Array<{ asset: string; side: 'buy' | 'sell'; usd: number }>;
  anomalies: string[];
  blocked: string | null;
  nextDelayMinutes: number;
}

export type S4CycleResult = DecideResult & { s4: S4Report | null };

export async function s4Cycle(nowFn: () => number = Date.now): Promise<S4CycleResult> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('S4 needs its persistent state (Supabase) — no order is placed without it.');
  // The bench's contract, asserted against production's: caps 35/35/20/15, floor 2 %.
  const cfg = buildBenchConfig();
  const assets = tradableBaseAssets(config).slice().sort();
  if (assets.join(',') !== cfg.assets.join(',')) throw new Error(`S4: production trades [${assets}], the bench [${cfg.assets}]`);
  if (config.primaryTimeframe !== '1d') throw new Error('S4 reads daily closes: primaryTimeframe must be 1d');
  const barMs = timeframeMs(config.regime.timeframe);
  const gitSha = getGitSha();

  let context: MarketContext;
  try {
    context = await buildMarketContext();
  } catch (err) {
    const salvaged = marketHealthOf(err);
    if (salvaged && salvaged.failures.length > 0) {
      await recordMarketDataOutage({
        supabase, decisionId: null, runToken: null, blind: salvaged.blind, marketsAttempted: salvaged.attempted,
        marketsFailed: salvaged.lost, failures: salvaged.failures, httpTraces: salvaged.httpTraces, tracesDropped: salvaged.tracesDropped,
      });
    }
    throw err;
  }
  const nowMs = nowFn();
  const health = context.dataHealth;
  const marketData: SeenMarket = health.blind ? 'blind' : 'sighted';
  const observeOutage = async (decisionId: number | null): Promise<void> => {
    if (health.failures.length === 0) return;
    await recordMarketDataOutage({
      supabase, decisionId, runToken: null, blind: health.blind, marketsAttempted: health.attempted,
      marketsFailed: health.lost, failures: health.failures, httpTraces: health.httpTraces, tracesDropped: health.tracesDropped,
    });
  };

  const reserve = reserveStables(config)[0] ?? 'USDT';
  const priceOf = buildPriceLookup(context, reserve);
  const [ledgerRead, capital, stateRead, positionRead] = await Promise.all([
    loadLedger(supabase),
    loadStartingCapital(supabase),
    readS4State(supabase, assets),
    loadPositionStates(supabase),
  ]);
  const startingCapital = capital ?? dec(config.execution.startingCapitalUsd);
  const portfolio = derivePortfolio(ledgerRead.entries, { startingCapital, reserveAsset: reserve, priceOf });

  const finish = async (
    status: 'skipped' | 'error',
    reason: string,
    s4: S4Report | null,
  ): Promise<S4CycleResult> => {
    const row = makeS4Row(context, gitSha, {
      status,
      skip_reason: status === 'skipped' ? reason : null,
      reasoning: reason,
      applied_delay_minutes: status === 'skipped' ? S4_RETRY_DELAY_MINUTES : null,
      market_context: { strategy: 'S4', reason, book: bookOf(portfolio) },
    });
    const { persisted, id } = await insertDecision(supabase, row);
    await observeOutage(id);
    console.warn(`[s4] cycle ${status}: ${reason}`);
    return baseResult(status, persisted, id, row, marketData, portfolio, portfolio, [], null, s4);
  };

  if (!ledgerRead.ok) return finish('error', 'journal des exécutions illisible — aucun ordre sans livre', null);
  if (!stateRead.ok) return finish('error', `état S4 illisible : ${stateRead.reason}`, null);
  const { pilot } = stateRead;
  // The pilot STARTS on its first cycle allowed to trade: a cycle run with the breaker off (a
  // cautious first deployment) decides and journals, but is not the pilot's opening.
  const firstCycle = pilot.startedAtMs == null && pilot.ordersEnabled;
  if (health.blind) {
    const reason = 'marché aveugle — aucune paire tradable lue';
    return finish('skipped', reason, emptyReport(pilot, firstCycle, stateRead.lines, [], reason));
  }

  // ── THE BOOK, AND THE ENTRIES KEPT IN STEP WITH IT ─────────────────────────────────────
  const qtyOf = (asset: string) => portfolio.positions.find((p) => p.asset === asset)?.qty ?? ZERO;
  const heldBefore = Object.fromEntries(assets.map((a) => [a, qtyOf(a).gt(0)]));
  const repaired = reconcileEntries({ lines: stateRead.lines, held: heldBefore, atMs: nowMs, pending: pilot.pending });
  const anomalies = [...repaired.anomalies];
  if (pilot.pending) anomalies.unshift(`exécution du cycle ${pilot.pending.decisionId} interrompue avant son enregistrement — entrées rapprochées depuis le livre`);
  let lines = repaired.lines;

  // ── 2. THE STATE DECISION ──────────────────────────────────────────────────────────────
  const closes = dueCloses(pilot.lastCloseMs, nowMs);
  let events: S4CloseEvent[] = [];
  if (closes.length > 0) {
    const daily = readDailyTable(context.dailySeries, assets, cfg.basket, nowMs);
    const blocked = daily.ok ? missingClose(daily.table, closes) : daily.reason;
    if (blocked != null || !daily.ok) {
      const first = closes[0]!;
      const reason = `clôture journalière S4 du ${isoDay(first)} non disponible (${blocked}) — décision bloquée, retentée au prochain réveil`;
      if (pilot.blockedCloseAlertedMs !== first) {
        await sendTelegram(`⚠️ Crypto-Buddy S4 · ${reason}. Aucun ordre placé.`);
        await markBlockedCloseAlerted(supabase, first);
      }
      return finish('skipped', reason, emptyReport(pilot, firstCycle, lines, anomalies, reason));
    }
    const holdings: Record<string, HoldingView> = Object.fromEntries(
      lines.map((l) => [l.asset, { held: heldBefore[l.asset] === true, entryAtMs: l.entryAtMs }]),
    );
    const step = applyDailyCloses({ lines, table: daily.table, closes, holdings });
    const committed = await commitCloses(supabase, {
      expectedLastCloseMs: pilot.lastCloseMs,
      newLastCloseMs: closes[closes.length - 1]!,
      lines: step.lines,
      daysOut: daysOutOf(step.lines, closes[closes.length - 1]!),
      events: step.events,
      gitSha,
    });
    if (!committed.ok) {
      const reason = `clôtures ${closes.map(isoDay).join(', ')} non enregistrées (${committed.reason}) — aucun ordre`;
      await sendTelegram(`⚠️ Crypto-Buddy S4 · ${reason}.`);
      return finish('error', reason, null);
    }
    lines = step.lines;
    events = step.events;
  } else if (repaired.anomalies.length > 0 || pilot.pending) {
    await saveLines(supabase, lines, daysOutOf(lines, pilot.lastCloseMs));
  }

  // ── 3. THE EXECUTION ENGINE ────────────────────────────────────────────────────────────
  const out = new Set(lines.filter((l) => l.status === 'out').map((l) => l.asset));
  const gates = Object.fromEntries(
    assets.map((asset) => {
      const pos = portfolio.positions.find((p) => p.asset === asset);
      return [asset, s4Gate({
        asset,
        sticky: context.transition?.perAsset[asset] ?? null,
        qty: pos?.qty ?? ZERO,
        price: priceOf(asset),
        priceStale: pos?.priceStale ?? false,
        stopThresholdPercent: config.transition.peakStopPercent,
      })];
    }),
  );
  const weights = Object.fromEntries(
    assets.map((asset) => {
      const pos = portfolio.positions.find((p) => p.asset === asset);
      return [asset, pos && portfolio.equity.gt(0) ? pos.value.div(portfolio.equity).times(100).toNumber() : 0];
    }),
  );
  const priced = Object.fromEntries(assets.map((a) => [a, priceOf(a) != null]));
  const { lines: plan } = s4Allocation({ assets, basket: cfg.basket, caps: cfg.caps, out, gates, weights, priced });
  const allocation = plannerAllocation(plan, reserve);
  const movements: Movement[] = computeMovements(portfolio, allocation, priceOf, config.execution.feePercent, cfg.minMovementPercent);

  // ── 4. THE DECISION ROW, THE ORDERS, THE ENTRIES ───────────────────────────────────────
  const delay = nextCycleDelayMinutes(nowMs, barMs, S4_CYCLE_OFFSET_MINUTES);
  const exits = events.filter((e) => e.kind === 'exit');
  const summary = describeCycle({ closes, events, plan, movements, ordersEnabled: pilot.ordersEnabled, firstCycle });
  const row = makeS4Row(context, gitSha, {
    status: 'decided',
    skip_reason: null,
    target_allocation: allocation,
    applied_allocation: allocation,
    action_type: movements.length === 0 ? 'hold' : exits.length > 0 ? 'de_risk' : 'rebalance',
    what_changed: closes.length === 0 ? 'aucune nouvelle clôture journalière' : summary.closes,
    reasoning: summary.text,
    notification_summary: summary.short,
    applied_delay_minutes: delay,
    market_context: {
      strategy: 'S4',
      pilot: { label: pilot.label, ordersEnabled: pilot.ordersEnabled, firstCycle },
      closesDecided: closes.map((c) => new Date(c).toISOString()),
      events,
      lines,
      plan,
      book: bookOf(portfolio),
      regimeBarAt: context.transition ? new Date(context.transition.barAtMs).toISOString() : null,
    },
  });
  const { persisted, id } = await insertDecision(supabase, row);
  if (id != null && closes.length > 0) await linkCloseDecisions(supabase, closes, id);

  let execution: ExecutionSummary | null = null;
  const withheld: S4Report['withheld'] = [];
  if (id == null) {
    if (movements.length > 0) console.warn('[s4] decision not persisted — movements NOT executed (no order without a durable booking).');
  } else if (movements.length === 0) {
    execution = emptyExecutionSummary();
  } else if (!pilot.ordersEnabled) {
    execution = emptyExecutionSummary();
    for (const m of movements) withheld.push({ asset: m.asset, side: m.side, usd: m.notional.toNumber() });
    console.warn(`[s4] breaker: orders_enabled = false — ${movements.length} leg(s) withheld, no order sent.`);
  } else {
    const pending: S4PendingExecution = {
      decisionId: id,
      atMs: nowMs,
      openCandidates: assets.filter((a) => !heldBefore[a] && (allocation[a] ?? 0) > 0),
      legs: movements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional.toNumber() })),
    };
    if (!(await setPending(supabase, pending))) {
      // Without the marker a crash mid-orders could not be reconciled exactly: refuse to trade.
      await observeOutage(id);
      return baseResult('decided', persisted, id, row, marketData, portfolio, portfolio, movements, emptyExecutionSummary(), {
        ...emptyReport(pilot, firstCycle, lines, [...anomalies, 'exécution en attente non enregistrée — ordres reportés au cycle suivant'], null),
        closesDecided: closes, events, plan, nextDelayMinutes: S4_RETRY_DELAY_MINUTES,
      });
    }
    execution = await executeMovements(movements, {
      decisionId: id,
      supabase,
      publicClient: publicMainnetClient(),
      testnetClient: testnetAccountClient(),
      priceSource: context.source.marketData,
      feePercent: config.execution.feePercent,
      cash: portfolio.cash,
      targetReserve: portfolio.equity.times(allocation[reserve] ?? 0).div(100),
      floor: movementFloor(portfolio.equity, cfg.minMovementPercent),
    });
  }

  const bookedLedger = execution?.bookedLedger ?? [];
  const portfolioAfter: VirtualPortfolio =
    bookedLedger.length > 0
      ? derivePortfolio([...ledgerRead.entries, ...bookedLedger], { startingCapital, reserveAsset: reserve, priceOf })
      : portfolio;

  // The movements, each with its cause — read by the notification.
  const byAsset = new Map<string, S4Movement>();
  for (const e of bookedLedger) {
    const asset = e.symbol.split('/')[0]!;
    const side = e.baseDelta.gt(0) ? 'buy' : 'sell';
    const line = lines.find((l) => l.asset === asset);
    const reason: S4MoveReason = firstCycle
      ? 'transition_initiale'
      : side === 'sell' && line?.status === 'out'
        ? 'sortie_s4'
        : side === 'buy' && !heldBefore[asset] && line?.lastMoveReason === 'rachat_s4'
          ? 'rachat_s4'
          : 'reequilibrage';
    const prev = byAsset.get(asset);
    if (prev) prev.usd += e.quoteDelta.abs().toNumber();
    else byAsset.set(asset, { asset, side, usd: e.quoteDelta.abs().toNumber(), reason });
  }
  const moved = [...byAsset.values()].sort((a, b) => b.usd - a.usd);

  if (execution && id != null && pilot.ordersEnabled && movements.length > 0) {
    const heldAfter = Object.fromEntries(
      assets.map((a) => [a, (portfolioAfter.positions.find((p) => p.asset === a)?.qty ?? ZERO).gt(0)]),
    );
    const opened: Record<string, number> = {};
    for (const e of bookedLedger) {
      const asset = e.symbol.split('/')[0]!;
      if (!heldBefore[asset] && heldAfter[asset]) opened[asset] = e.valuationPrice.toNumber();
    }
    const recorded = reconcileEntries({ lines, held: heldAfter, opened, atMs: nowMs });
    lines = recorded.lines.map((l) => {
      const m = byAsset.get(l.asset);
      return m ? { ...l, lastMoveReason: m.reason, lastMoveAtMs: nowMs } : l;
    });
    const linesSaved = await saveLines(supabase, lines, daysOutOf(lines, closes.at(-1) ?? pilot.lastCloseMs));
    // Cleared only once the entries are written: otherwise the next cycle repairs from it.
    if (linesSaved) await setPending(supabase, null);
  }

  if (firstCycle && id != null) {
    await markPilotStarted(supabase, { decisionId: id, gitSha, startingEquityUsd: portfolio.equity.toNumber(), atMs: nowMs });
  }

  // position_state (dashboard): the code-owned lifecycle, best-effort, never read by S4.
  if (positionRead.ok) {
    await savePositionStates(
      supabase,
      nextPositionStates({ assets, previous: positionRead.states, portfolio: portfolioAfter, priceOf, bookedLedger, now: context.generatedAt }),
      context.generatedAt,
    );
  }
  await observeOutage(id);
  if (anomalies.length > 0) await sendTelegram(`⚠️ Crypto-Buddy S4 · ${anomalies.join(' ; ')}.`);

  const s4: S4Report = {
    label: pilot.label,
    ordersEnabled: pilot.ordersEnabled,
    firstCycle,
    closesDecided: closes,
    events,
    lines,
    plan,
    movements: moved,
    withheld,
    anomalies,
    blocked: null,
    nextDelayMinutes: delay,
  };
  return baseResult('decided', persisted, id, row, marketData, portfolio, portfolioAfter, movements, execution, s4);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

function emptyReport(pilot: { label: string; ordersEnabled: boolean }, firstCycle: boolean, lines: S4Line[], anomalies: string[], blocked: string | null): S4Report {
  return {
    label: pilot.label, ordersEnabled: pilot.ordersEnabled, firstCycle, closesDecided: [], events: [], lines, plan: [],
    movements: [], withheld: [], anomalies, blocked, nextDelayMinutes: S4_RETRY_DELAY_MINUTES,
  };
}

function daysOutOf(lines: S4Line[], atCloseMs: number): Record<string, number | null> {
  return Object.fromEntries(
    lines.map((l) => [l.asset, l.status === 'out' && l.exitAtMs != null ? Math.floor((atCloseMs - l.exitAtMs) / DAY_MS) : null]),
  );
}

function bookOf(p: VirtualPortfolio): Record<string, unknown> {
  return {
    equity: p.equity.toNumber(),
    cash: p.cash.toNumber(),
    positions: p.positions.map((x) => ({ asset: x.asset, qty: x.qty.toString(), price: x.price.toNumber(), stale: x.priceStale, value: x.value.toNumber() })),
  };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const MOVE_LABEL: Record<S4MoveReason, string> = {
  reprise_etat_banc: 'reprise de l\'état du banc',
  transition_initiale: 'transition initiale vers l\'état S4',
  sortie_s4: 'sortie S4',
  rachat_s4: 'rachat S4',
  reequilibrage: 'rééquilibrage',
};
export { MOVE_LABEL };

function describeCycle(p: {
  closes: number[];
  events: S4CloseEvent[];
  plan: S4LinePlan[];
  movements: Movement[];
  ordersEnabled: boolean;
  firstCycle: boolean;
}): { text: string; short: string; closes: string } {
  const decided = p.events.filter((e) => e.kind === 'exit' || e.kind === 'rebuy' || e.kind === 'armed');
  const closes =
    p.closes.length === 0
      ? 'aucune nouvelle clôture'
      : `clôture(s) ${p.closes.map(isoDay).join(', ')} : ` +
        (decided.length === 0 ? 'aucun changement d\'état' : decided.map((e) => `${e.asset} ${e.kind === 'exit' ? 'sort' : e.kind === 'rebuy' ? 'rachat autorisé' : 'recroisement armé'}`).join(', '));
  const targets = p.plan.map((l) => `${l.asset} ${l.targetPercent.toFixed(2)} % (${l.state}${l.hold ? ', maintenu' : ''})`).join(' ; ');
  const legs = p.movements.map((m) => `${m.side === 'buy' ? 'achat' : 'vente'} ${m.asset} ${m.notional.toFixed(2)} $`).join(', ');
  const text =
    `S4${p.firstCycle ? ' (premier cycle du pilote)' : ''} — ${closes}. Cibles : ${targets}. ` +
    (p.movements.length === 0 ? 'Aucun mouvement au-delà du plancher.' : `Mouvements : ${legs}.`) +
    (p.ordersEnabled ? '' : ' Coupe-circuit actif : aucun ordre envoyé.');
  const short = p.movements.length === 0 ? `S4 : ${closes}, aucun mouvement.` : `S4 : ${closes} ; ${legs}.`;
  return { text, short, closes };
}

function makeS4Row(
  context: MarketContext,
  gitSha: string | null,
  f: Partial<DecisionRow> & Pick<DecisionRow, 'status' | 'skip_reason' | 'market_context'>,
): DecisionRow {
  return {
    target_allocation: null,
    intent_allocation: null,
    applied_allocation: null,
    clamped: null,
    clamp_reason: null,
    applied_divergence_cause: null,
    action_type: null,
    what_changed: null,
    confidence: null,
    market_state: null,
    reasoning: null,
    notification_summary: null,
    requested_delay_minutes: null,
    applied_delay_minutes: null,
    regime: context.regime,
    model: null,
    prompt_version: S4_PROMPT_VERSION,
    git_sha: gitSha,
    coherence_guard_armed: null,
    raw_response: null,
    latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    ...f,
  };
}

function baseResult(
  status: DecisionRow['status'],
  persisted: boolean,
  decisionId: number | null,
  row: DecisionRow,
  marketData: SeenMarket,
  portfolio: VirtualPortfolio,
  portfolioAfter: VirtualPortfolio,
  movements: Movement[],
  execution: ExecutionSummary | null,
  s4: S4Report | null,
): S4CycleResult {
  return {
    status, persisted, decisionId, row, marketData, portfolio, portfolioAfter,
    clamp: null, movements, execution, provenance: null, llmFailure: null, s4,
  };
}

