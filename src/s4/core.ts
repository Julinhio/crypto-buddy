import { buildDailyTable, type DailyTable } from '../bench/exit/daily.js';
import { EXIT_PARAMETERS } from '../bench/exit/parameters.js';
import { stepTrailingLine, type TrailingLine } from '../bench/exit/rules.js';
import { allocate, stateFromGate, type AllocLine, type Allocation, type LineState } from '../bench/exposure/allocate.js';
import type { HoldingView } from '../bench/exposure/engine.js';
import type { Tape } from '../bench/exposure/tape.js';
import type { Candle } from '../market/klines.js';
import type { StickyPoint } from '../market/transition.js';
import { evaluateTransition, type TransitionGate } from '../transition/gate.js';
import type { Decimal } from '../money.js';

/**
 * S4 IN PRODUCTION — THE PURE CORE. No I/O, no clock: every input is passed in, so the same
 * function runs in the live cycle and in the equivalence test against the bench.
 *
 * Two layers, and they are kept apart on purpose (brief of 06/11/2026):
 *
 *   1. THE STATE DECISION, once per daily UTC close: `applyDailyCloses` runs the bench's own
 *      `stepTrailingLine` (S4: 20 % trailing stop on daily closes, ≥ 10 days out, rebuy on a
 *      re-crossing of the 50-day mean) on each close not yet consumed, in order.
 *   2. THE EXECUTION ENGINE, on every 4h cycle: `s4Allocation` maps the transition gate and the
 *      rule's out-set to line states exactly as the bench engine does (`engine.ts`), then calls
 *      the bench's own `allocate` (100 % at 32.5 / 32.5 / 20 / 15, caps 35 / 35 / 20 / 15, an
 *      out line's share kept in cash). The plumbing floor and the drift rebalancing happen
 *      downstream, in production's `planMovements`, as in the bench.
 *
 * What the bench does and this core therefore does too:
 *   - the gate is BLIND to the global risk_off (policy T100: `riskOffConfirmed = false`);
 *   - the 10 % peak stop never fires: a `stop_exit` verdict reads as `frozen`;
 *   - a line the rule holds out is `excluded` WHATEVER its gate says — an S4 exit passes a
 *     freeze — and goes to zero (A1: nothing recreates it);
 *   - a line the rule holds in obeys the gate — a frozen line is not bought back while frozen.
 */

const DAY_MS = 86_400_000;

export const S4_MIN_DAYS_OUT = EXIT_PARAMETERS.minDaysOut;
export const S4_TRAILING_STOP_PERCENT = EXIT_PARAMETERS.trailingStopPercent;
export const S4_MEAN_DAYS = EXIT_PARAMETERS.shortMeanDays;

/** Why a line last moved — persisted with it, and read by the notification. */
export type S4MoveReason =
  | 'reprise_etat_banc'
  | 'transition_initiale'
  | 'sortie_s4'
  | 'rachat_s4'
  | 'reequilibrage';

/** One asset's S4 state, as persisted. The first five fields are the bench's `TrailingLine`. */
export interface S4Line {
  asset: string;
  status: 'in' | 'out';
  /** The fill the trailing high belongs to (flat → held). Null while out, or in and never bought. */
  entryAtMs: number | null;
  /** Highest daily close observed strictly after `entryAtMs`. */
  high: number | null;
  /** The daily close that decided the exit. */
  exitAtMs: number | null;
  /** A close at or under the 50-day mean has been seen since the exit. */
  armed: boolean;
  /** Valuation price of the entry fill, for the record. Never read by the rule. */
  entryPrice: number | null;
  lastMoveReason: S4MoveReason | null;
  lastMoveAtMs: number | null;
}

/** What one daily close did to one line. One row per (close, asset) in the journal. */
export interface S4CloseEvent {
  closeMs: number;
  asset: string;
  kind: 'exit' | 'rebuy' | 'armed' | 'high' | 'hold';
  close: number;
  sma50: number;
  statusBefore: 'in' | 'out';
  statusAfter: 'in' | 'out';
  highBefore: number | null;
  /** The high the close was judged against (the exit threshold is 80 % of it). */
  highAfter: number | null;
  thresholdPrice: number | null;
  armedAfter: boolean;
  /** Days since the exit at this close, for a line out (after the step). */
  daysOut: number | null;
}

export function trailingOf(line: S4Line): TrailingLine {
  return { status: line.status, entryAtMs: line.entryAtMs, high: line.high, exitAtMs: line.exitAtMs, armed: line.armed };
}

// ── 1. THE DAILY CLOSES ─────────────────────────────────────────────────────────────────

export type DailyRead =
  | { ok: true; table: DailyTable; latestCloseMs: number }
  | { ok: false; reason: string };

/**
 * The bench's own daily table, built from the CLOSED daily candles only. A candle opened at `T`
 * is known at `T + 24 h`, never before: the still-forming candle ccxt returns last is dropped
 * here, so no decision can read it. A non-finite or non-positive close, a hole, or an asset
 * missing makes the read fail — never a silently shorter series.
 */
export function readDailyTable(
  series: Readonly<Record<string, readonly Candle[] | undefined>>,
  assets: readonly string[],
  basket: Readonly<Record<string, number>>,
  nowMs: number,
): DailyRead {
  const tapes: Record<string, { daily: Candle[] }> = {};
  for (const asset of assets) {
    const candles = series[asset];
    if (!candles || candles.length === 0) return { ok: false, reason: `${asset}: aucune bougie journalière lue` };
    const closed = candles.filter((c) => c.timestamp + DAY_MS <= nowMs);
    const bad = closed.find((c) => !(Number.isFinite(c.close) && c.close > 0) || c.timestamp % DAY_MS !== 0);
    if (bad) return { ok: false, reason: `${asset}: bougie journalière invalide ouverte le ${iso(bad.timestamp)}` };
    tapes[asset] = { daily: closed };
  }
  try {
    // `buildDailyTable` reads only `tradable` and each asset's `daily`: the rest of a tape is
    // the 4h machinery, which this layer never touches.
    const tape = { tradable: [...assets], tapes } as unknown as Tape;
    const table = buildDailyTable(tape, basket);
    const latest = table.rows[table.rows.length - 1];
    if (!latest) return { ok: false, reason: 'aucune clôture journalière commune' };
    return { ok: true, table, latestCloseMs: latest.closeMs };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The daily closes after `lastCloseMs` that have happened by `nowMs`, oldest first. */
export function dueCloses(lastCloseMs: number, nowMs: number): number[] {
  if (lastCloseMs % DAY_MS !== 0) throw new Error(`S4: the last consumed close ${iso(lastCloseMs)} is not a UTC midnight`);
  const out: number[] = [];
  for (let t = lastCloseMs + DAY_MS; t <= nowMs; t += DAY_MS) out.push(t);
  return out;
}

/**
 * Every due close must be in the table with a 50-day mean for every asset. The first failure is
 * returned: the closes are consumed in order, so a missing one blocks itself AND every later one.
 */
export function missingClose(table: DailyTable, closes: readonly number[]): string | null {
  for (const closeMs of closes) {
    const i = table.rowByClose.get(closeMs);
    if (i == null) return `clôture du ${iso(closeMs)} absente ou non close`;
    const row = table.rows[i]!;
    for (const asset of table.assets) {
      if (row.sma50[asset] == null) return `${asset} : pas de moyenne 50 jours à la clôture du ${iso(closeMs)}`;
    }
  }
  return null;
}

/**
 * THE STATE DECISION. Runs the bench's step on each due close, in order, with the book as it
 * stands (nothing trades between two closes of a catch-up, so the holdings are constant).
 * Returns new lines (the input is not mutated) and one event per (close, asset).
 */
export function applyDailyCloses(params: {
  lines: readonly S4Line[];
  table: DailyTable;
  closes: readonly number[];
  holdings: Readonly<Record<string, HoldingView>>;
}): { lines: S4Line[]; events: S4CloseEvent[] } {
  const lines = params.lines.map((l) => ({ ...l }));
  const events: S4CloseEvent[] = [];
  const stop = 1 - S4_TRAILING_STOP_PERCENT / 100;
  for (const closeMs of params.closes) {
    const row = params.table.rows[params.table.rowByClose.get(closeMs) ?? -1];
    if (!row) throw new Error(`S4: no daily row at ${iso(closeMs)}`);
    for (const line of lines) {
      const close = row.close[line.asset];
      const mean = row.sma50[line.asset];
      if (close == null || mean == null) throw new Error(`S4: ${line.asset} has no close or 50-day mean at ${iso(closeMs)}`);
      const trailing = trailingOf(line);
      const before = { ...trailing };
      stepTrailingLine(trailing, { asset: line.asset, closeMs, close, mean, holding: params.holdings[line.asset] }, S4_MIN_DAYS_OUT);
      // The high the close was judged against: the bench's high after it ratcheted, before an
      // exit resets it.
      const judgedHigh =
        before.status === 'in' && trailing.status === 'out'
          ? Math.max(before.entryAtMs === params.holdings[line.asset]?.entryAtMs ? (before.high ?? close) : close, close)
          : trailing.high;
      let kind: S4CloseEvent['kind'] = 'hold';
      if (before.status === 'in' && trailing.status === 'out') kind = 'exit';
      else if (before.status === 'out' && trailing.status === 'in') kind = 'rebuy';
      else if (!before.armed && trailing.armed) kind = 'armed';
      else if (trailing.high !== before.high && trailing.high != null) kind = 'high';
      events.push({
        closeMs,
        asset: line.asset,
        kind,
        close,
        sma50: mean,
        statusBefore: before.status,
        statusAfter: trailing.status,
        highBefore: before.high,
        highAfter: judgedHigh,
        thresholdPrice: judgedHigh != null ? judgedHigh * stop : null,
        armedAfter: trailing.armed,
        daysOut: trailing.status === 'out' && trailing.exitAtMs != null ? Math.floor((closeMs - trailing.exitAtMs) / DAY_MS) : null,
      });
      line.status = trailing.status;
      line.entryAtMs = trailing.entryAtMs;
      line.high = trailing.high;
      line.exitAtMs = trailing.exitAtMs;
      line.armed = trailing.armed;
      if (kind === 'exit') {
        line.entryPrice = null;
        line.lastMoveReason = 'sortie_s4';
        line.lastMoveAtMs = closeMs;
      } else if (kind === 'rebuy') {
        line.lastMoveReason = 'rachat_s4';
        line.lastMoveAtMs = closeMs;
      }
    }
  }
  return { lines, events };
}

// ── 1b. THE ENTRIES, KEPT IN STEP WITH THE BOOK ─────────────────────────────────────────

/** Persisted before the orders of a cycle, cleared after them. */
export interface S4PendingExecution {
  decisionId: number;
  atMs: number;
  /** Lines flat before the orders, that the orders may open: their entry is this instant. */
  openCandidates: string[];
  legs: Array<{ asset: string; side: 'buy' | 'sell'; notional: number }>;
}

/**
 * The bench's position bookkeeping, applied to production's book: a line that went from flat
 * to held gets its entry at that fill (`report.opened`), a line sold to zero loses it
 * (`report.closedOut`). Topping up a held line is NOT a new entry — that is what keeps the
 * reconstructed highs when the book goes from ~5 % to its target.
 *
 * Run after the orders with the booked fills, and at the start of every cycle as a repair: a
 * cycle that died between its orders and its state write left `pending`, whose instant is the
 * entry of whatever it opened.
 */
export function reconcileEntries(params: {
  lines: readonly S4Line[];
  held: Readonly<Record<string, boolean>>;
  /** Lines opened by the fills being recorded, with their valuation price. */
  opened?: Readonly<Record<string, number>>;
  atMs: number;
  pending?: S4PendingExecution | null;
}): { lines: S4Line[]; anomalies: string[] } {
  const anomalies: string[] = [];
  const lines = params.lines.map((l) => ({ ...l }));
  for (const line of lines) {
    const held = params.held[line.asset] === true;
    if (!held) {
      if (line.entryAtMs != null) {
        line.entryAtMs = null;
        line.entryPrice = null;
      }
      continue;
    }
    if (line.status !== 'in' || line.entryAtMs != null) continue;
    const openedPrice = params.opened?.[line.asset];
    if (openedPrice != null) {
      line.entryAtMs = params.atMs;
      line.entryPrice = openedPrice;
    } else if (params.pending?.openCandidates.includes(line.asset)) {
      line.entryAtMs = params.pending.atMs;
      anomalies.push(`${line.asset} : entrée reprise de l'exécution interrompue du cycle ${params.pending.decisionId}`);
    } else {
      line.entryAtMs = params.atMs;
      anomalies.push(`${line.asset} : détenu en marché sans entrée enregistrée — entrée fixée à ${iso(params.atMs)}`);
    }
  }
  return { lines, anomalies };
}

// ── 2. THE EXECUTION ENGINE ─────────────────────────────────────────────────────────────

/** Production's gate as the bench's S4 run reads it: blind to the risk_off, stop disabled. */
export function s4Gate(input: {
  asset: string;
  sticky: StickyPoint | null;
  qty: Decimal;
  price: Decimal | null;
  priceStale: boolean;
  stopThresholdPercent: number;
}): TransitionGate {
  const verdict = evaluateTransition({
    asset: input.asset,
    sticky: input.sticky,
    riskOffConfirmed: false,
    qty: input.qty,
    price: input.price,
    priceStale: input.priceStale,
    peakPriceSinceEntry: null,
    stopThresholdPercent: input.stopThresholdPercent,
  }).gate;
  // Exactly the bench's mapping with `stopDisabled` and a gate that does not see the risk_off.
  return verdict === 'stop_exit' ? 'frozen' : verdict;
}

export interface S4LinePlan {
  asset: string;
  gate: TransitionGate;
  state: LineState;
  currentPercent: number;
  targetPercent: number;
  hold: boolean;
}

/**
 * The engine's per-bar allocation, line for line (`engine.ts`, "THE POLICY, then the
 * allocation", with policy T100: target 100, nothing excluded by the policy, nothing barred
 * since the stop never fires). One addition the bench never needs: a line with no live price is
 * held (`fixed`, `no_price`, as `allocate` documents) unless the rule holds it out.
 */
export function s4Allocation(params: {
  assets: readonly string[];
  basket: Readonly<Record<string, number>>;
  caps: Readonly<Record<string, number>>;
  out: ReadonlySet<string>;
  gates: Readonly<Record<string, TransitionGate>>;
  weights: Readonly<Record<string, number>>;
  priced: Readonly<Record<string, boolean>>;
}): { allocation: Allocation; lines: S4LinePlan[] } {
  const lines: AllocLine[] = params.assets.map((asset) => {
    const fromGate = stateFromGate(params.gates[asset]!);
    let state = fromGate.state;
    let fixedCause = fromGate.fixedCause;
    if (params.out.has(asset)) state = 'excluded';
    else if (!params.priced[asset]) {
      state = 'fixed';
      fixedCause = 'no_price';
    }
    return { asset, currentPercent: params.weights[asset] ?? 0, state, fixedCause };
  });
  const allocation = allocate({ policyTargetPercent: 100, basket: params.basket, caps: params.caps, lines });
  return {
    allocation,
    lines: allocation.lines.map((l) => ({
      asset: l.asset,
      gate: params.gates[l.asset]!,
      state: l.state,
      currentPercent: params.weights[l.asset] ?? 0,
      targetPercent: l.targetPercent,
      hold: l.hold,
    })),
  };
}

/**
 * The allocation production's planner takes: each line's target (a HOLD at its current weight,
 * so the planner sees no gap on it), the reserve derived — exactly as the bench's
 * `executeAllocation` builds it.
 */
export function plannerAllocation(lines: readonly S4LinePlan[], reserveAsset: string): Record<string, number> {
  const allocation: Record<string, number> = {};
  let risky = 0;
  for (const l of lines) {
    const pct = l.hold ? l.currentPercent : l.targetPercent;
    allocation[l.asset] = pct;
    risky += pct;
  }
  allocation[reserveAsset] = Math.max(0, 100 - risky);
  return allocation;
}

/** The next 4h boundary strictly after `nowMs`, plus the offset that lets its bar close. */
export function nextCycleDelayMinutes(nowMs: number, barMs: number, offsetMinutes: number): number {
  const next = (Math.floor(nowMs / barMs) + 1) * barMs + offsetMinutes * 60_000;
  return Math.max(1, Math.ceil((next - nowMs) / 60_000));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
