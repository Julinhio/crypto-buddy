import type { Exchange } from 'ccxt';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal } from '../money.js';
import {
  loadSymbolRules,
  snapQty,
  validateMovement,
  type SymbolRules,
} from './symbolRules.js';
import { placeMarketableIoc, type OrderResult } from './testnetOrder.js';
import {
  bookedIntent,
  executionTrace,
  rejectedIntent,
  type Movement,
} from './movements.js';
import { insertExecution } from '../persistence/executions.js';

/** Per-movement record of how the four states resolved this cycle. */
export interface ExecutionLine {
  symbol: string;
  side: 'buy' | 'sell';
  wantedQty: Decimal; // state 1 (sovereign, pre-snap)
  snappedQty: Decimal;
  booked: boolean; // did the sovereign ledger book it?
  verdict: 'ok' | 'crumb' | 'block' | 'rules_error' | 'not_booked';
  reason: string | null;
  order: OrderResult | null; // the testnet attempt (null when no order was sent)
}

export interface ExecutionSummary {
  lines: ExecutionLine[];
  booked: number;
  skipped: number;
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
}

/**
 * Executes this cycle's movements as REAL testnet orders, journaling the four
 * states cleanly. Per movement, strictly in this order (the crash-safe contract):
 *
 *   1. snap the sovereign qty to the symbol's lot step (mainnet, authoritative);
 *   2. validate against the real filters using the sovereign price — this verdict
 *      ALONE decides whether we book;
 *   3. a crumb/block (or a filters-load failure) → write a NON-booked intent,
 *      log, send nothing, move on (the gap stays for next cycle);
 *   4. otherwise write the booked intent FIRST (durable intention), THEN place a
 *      marketable LIMIT IOC on the testnet, THEN write the execution trace.
 *
 * The testnet result (reject / partial / zero / error) is traced but NEVER
 * touches the sovereign ledger — exactly as in PR A, the book is driven by our
 * own calculation at real prices.
 */
export async function executeMovements(
  movements: Movement[],
  deps: ExecuteDeps,
): Promise<ExecutionSummary> {
  const { decisionId, supabase, publicClient, testnetClient, priceSource, feePercent } = deps;
  const lines: ExecutionLine[] = [];
  const rulesCache = new Map<string, SymbolRules>();

  for (const m of movements) {
    // 1) Authoritative rules + snap. A failure to load them means we can't
    //    validate, so we must not book or send — trace it as a 'failed' intent.
    let rules: SymbolRules;
    try {
      let cached = rulesCache.get(m.symbol);
      if (!cached) {
        cached = await loadSymbolRules(publicClient, m.symbol);
        rulesCache.set(m.symbol, cached);
      }
      rules = cached;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[error] ${m.symbol}: could not load the real (mainnet) order filters (${msg}) — not booking, not sending.`,
      );
      await insertExecution(
        supabase,
        rejectedIntent(m, m.qty, decisionId, priceSource, 'failed', `mainnet filters unavailable: ${msg}`),
      );
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty: m.qty,
        booked: false, verdict: 'rules_error', reason: msg, order: null,
      });
      continue;
    }

    const snapped = snapQty(m.qty, rules);
    const verdict = validateMovement(snapped, m.price, rules);

    // 2) Crumb / block → clean no-op (journaled, not booked, no order, no escalation
    //    for a crumb; a louder warn for an unexpected block).
    if (verdict.kind !== 'ok') {
      const status = verdict.kind === 'crumb' ? 'rejected' : 'failed';
      if (verdict.kind === 'crumb') {
        console.log(`[skip] ${m.side} ${m.symbol}: ${verdict.reason} — clean no-op, gap left for next cycle.`);
      } else {
        console.warn(`[warn] ${m.side} ${m.symbol}: ${verdict.reason} — not booking, not sending.`);
      }
      await insertExecution(supabase, rejectedIntent(m, snapped, decisionId, priceSource, status, verdict.reason));
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty: snapped,
        booked: false, verdict: verdict.kind, reason: verdict.reason, order: null,
      });
      continue;
    }

    // 3) Book the intention DURABLY before any exchange call. If we can't persist
    //    it (Supabase down/insert failed), we must NOT place the order — there'd be
    //    no durable record to reconcile against. Skip and warn (book unchanged).
    const { id: intentId } = await insertExecution(
      supabase,
      bookedIntent(m, snapped, decisionId, priceSource, feePercent),
    );
    if (intentId == null) {
      console.warn(
        `[warn] ${m.side} ${m.symbol}: intent NOT durably journaled — skipping the testnet order (no order without a durable booking).`,
      );
      lines.push({
        symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty: snapped,
        booked: false, verdict: 'not_booked', reason: 'intent not persisted', order: null,
      });
      continue;
    }

    // 4) Place the marketable LIMIT IOC, then trace the result (never touches the book).
    const order = await placeMarketableIoc(testnetClient, m.symbol, m.side, snapped);
    await insertExecution(supabase, executionTrace(m, snapped, intentId, decisionId, order));
    console.log(
      `[order] ${m.side} ${m.symbol}: booked; testnet ${order.outcome}` +
        `${order.orderId ? ` (#${order.orderId})` : ''}` +
        `${order.errorCode ? ` code=${order.errorCode}` : ''}.`,
    );
    lines.push({
      symbol: m.symbol, side: m.side, wantedQty: m.qty, snappedQty: snapped,
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
    booked: 0, skipped: 0, ordersPlaced: 0,
    filled: 0, partial: 0, unfilled: 0, rejected: 0, errored: 0,
  };
  for (const l of lines) {
    if (l.booked) s.booked += 1;
    else s.skipped += 1;
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
