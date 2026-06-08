import type { Exchange } from 'ccxt';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal } from '../money.js';
import { loadSymbolRules, type SymbolRules } from './symbolRules.js';
import { planMovements } from './plan.js';
import { placeMarketableIoc, type OrderResult } from './testnetOrder.js';
import {
  bookedIntent,
  executionTrace,
  movementKey,
  rejectedIntent,
  type Movement,
} from './movements.js';
import { bookIntent, insertExecution } from '../persistence/executions.js';

/** Per-movement record of how the four states resolved this cycle. */
export interface ExecutionLine {
  symbol: string;
  side: 'buy' | 'sell';
  wantedQty: Decimal; // state 1 (sovereign, pre-snap)
  snappedQty: Decimal;
  booked: boolean; // did the sovereign ledger book it?
  verdict: 'ok' | 'crumb' | 'block' | 'rules_error' | 'not_booked' | 'already_booked';
  reason: string | null;
  order: OrderResult | null; // the testnet attempt (null when no order was sent)
}

export interface ExecutionSummary {
  lines: ExecutionLine[];
  booked: number;
  skipped: number;
  /** Movements that were already booked by a prior attempt (idempotent replay no-op). */
  deduped: number;
  ordersPlaced: number;
  filled: number;
  partial: number;
  unfilled: number;
  rejected: number;
  errored: number;
}

export interface ExecuteDeps {
  decisionId: number;
  supabase: SupabaseClient | null;
  /** Public MAINNET client — the AUTHORITATIVE filters for validation/snapping. */
  publicClient: Exchange;
  /** Authenticated TESTNET client — where the real orders go. */
  testnetClient: Exchange;
  /** Source tag for the sovereign price (e.g. 'binance-public-mainnet'). */
  priceSource: string;
  feePercent: number;
  /** Free cash before this cycle — used to size buys on post-snap reality. */
  cash: Decimal;
  /** Reserve value the risk wrapper wants kept in cash (equity × reserve%). */
  targetReserve: Decimal;
}

/**
 * Executes this cycle's movements as REAL testnet orders, journaling the four
 * states cleanly. The snapping / validation / floor-safe reconciliation is done
 * by the pure `planMovements`; this function does the I/O around it.
 *
 * Per planned movement, strictly in this order (the crash-safe contract):
 *   1. a crumb/block (or a filters-load failure) → write a NON-booked intent,
 *      log, send nothing, move on (the gap stays for next cycle);
 *   2. otherwise write the booked intent FIRST (durable intention), THEN place a
 *      marketable LIMIT IOC on the testnet, THEN write the execution trace.
 *
 * The testnet result (reject / partial / zero / error) is traced but NEVER
 * touches the sovereign ledger — the book is driven by our own calculation at
 * real prices, exactly as in PR A.
 */
export async function executeMovements(
  movements: Movement[],
  deps: ExecuteDeps,
): Promise<ExecutionSummary> {
  const { decisionId, supabase, publicClient, testnetClient, priceSource, feePercent, cash, targetReserve } = deps;

  // Load the authoritative (mainnet) rules for each distinct symbol up front —
  // the plan needs every symbol's rules to snap, validate and reconcile.
  const rulesCache = new Map<string, SymbolRules>();
  const ruleError = new Map<string, string>();
  for (const symbol of new Set(movements.map((m) => m.symbol))) {
    try {
      rulesCache.set(symbol, await loadSymbolRules(publicClient, symbol));
    } catch (err) {
      ruleError.set(symbol, err instanceof Error ? err.message : String(err));
    }
  }

  // Plan only the movements whose rules loaded (we can't validate the others).
  const resolvable = movements.filter((m) => rulesCache.has(m.symbol));
  const plan = planMovements(resolvable, {
    rulesOf: (s) => rulesCache.get(s)!,
    cash,
    targetReserve,
    feePercent,
  });
  const planned = new Map(plan.map((p) => [p.movement, p]));

  const lines: ExecutionLine[] = [];
  for (const m of movements) {
    // Rules unavailable → can't validate authoritatively, so don't book or send.
    if (!rulesCache.has(m.symbol)) {
      const reason = `mainnet filters unavailable: ${ruleError.get(m.symbol) ?? 'unknown'}`;
      console.error(`[error] ${m.side} ${m.symbol}: ${reason} — not booking, not sending.`);
      await insertExecution(supabase, rejectedIntent(m, m.qty, decisionId, priceSource, 'failed', reason));
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty: m.qty,
        booked: false, verdict: 'rules_error', reason, order: null,
      });
      continue;
    }

    const { snappedQty, verdict } = planned.get(m)!;

    // Crumb / block → clean no-op (journaled, not booked, no order; quiet for a
    // crumb, a louder warn for an unexpected block).
    if (verdict.kind !== 'ok') {
      const status = verdict.kind === 'crumb' ? 'rejected' : 'failed';
      if (verdict.kind === 'crumb') {
        console.log(`[skip] ${m.side} ${m.symbol}: ${verdict.reason} — clean no-op, gap left for next cycle.`);
      } else {
        console.warn(`[warn] ${m.side} ${m.symbol}: ${verdict.reason} — not booking, not sending.`);
      }
      await insertExecution(supabase, rejectedIntent(m, snappedQty, decisionId, priceSource, status, verdict.reason));
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty,
        booked: false, verdict: verdict.kind, reason: verdict.reason, order: null,
      });
      continue;
    }

    // Book the intention DURABLY before any exchange call, IDEMPOTENTLY. The unique
    // idempotency_key makes a replay of THIS decision's movement (a resend after a
    // timeout, a re-entered cycle) a clean no-op: it can neither double-book nor reach
    // a second order. Three outcomes:
    const key = movementKey(decisionId, m.symbol, m.side);
    const outcome = await bookIntent(
      supabase,
      bookedIntent(m, snappedQty, decisionId, priceSource, feePercent, key),
    );

    // Already booked by a prior attempt → idempotent no-op. Do NOT re-book, do NOT
    // place an order; journal a line, never throw (a replay won't restart backoff).
    if (outcome.kind === 'duplicate') {
      console.log(
        `[idempotent] ${m.side} ${m.symbol}: already booked (key ${key}) — clean no-op, no order placed.`,
      );
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty,
        booked: false, verdict: 'already_booked', reason: 'already booked (idempotent replay)', order: null,
      });
      continue;
    }

    // Couldn't persist (Supabase down / insert failed) → must NOT place the order:
    // there'd be no durable record to reconcile against. Skip and warn (book unchanged).
    if (outcome.kind === 'unpersisted') {
      console.warn(
        `[warn] ${m.side} ${m.symbol}: intent NOT durably journaled — skipping the testnet order (no order without a durable booking).`,
      );
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty,
        booked: false, verdict: 'not_booked', reason: 'intent not persisted', order: null,
      });
      continue;
    }

    // We WON the booking → this attempt owns the order. Place the marketable LIMIT
    // IOC carrying the SAME key as clientOrderId (the order face), then trace the
    // result (never touches the book).
    const intentId = outcome.id;
    const order = await placeMarketableIoc(testnetClient, m.symbol, m.side, snappedQty, key);
    await insertExecution(supabase, executionTrace(m, snappedQty, intentId, decisionId, order));
    console.log(
      `[order] ${m.side} ${m.symbol}: booked; testnet ${order.outcome}` +
        `${order.orderId ? ` (#${order.orderId})` : ''}` +
        `${order.errorCode ? ` code=${order.errorCode}` : ''}.`,
    );
    lines.push({
      symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty,
      booked: true, verdict: 'ok', reason: null, order,
    });
  }

  return summarize(lines);
}

/** A zeroed summary — used when there's nothing to execute (already at target). */
export function emptyExecutionSummary(): ExecutionSummary {
  return summarize([]);
}

function summarize(lines: ExecutionLine[]): ExecutionSummary {
  const s: ExecutionSummary = {
    lines,
    booked: 0, skipped: 0, deduped: 0, ordersPlaced: 0,
    filled: 0, partial: 0, unfilled: 0, rejected: 0, errored: 0,
  };
  for (const l of lines) {
    if (l.booked) s.booked += 1;
    else s.skipped += 1;
    if (l.verdict === 'already_booked') s.deduped += 1; // a subset of skipped, surfaced
    if (l.order) {
      s.ordersPlaced += 1;
      switch (l.order.outcome) {
        case 'filled': s.filled += 1; break;
        case 'partial': s.partial += 1; break;
        case 'unfilled': s.unfilled += 1; break;
        case 'rejected': s.rejected += 1; break;
        case 'error': s.errored += 1; break;
      }
    }
  }
  return s;
}
