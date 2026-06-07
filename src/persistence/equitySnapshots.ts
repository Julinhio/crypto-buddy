import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decimal } from '../money.js';
import type { VirtualPortfolio } from '../portfolio/derive.js';

const TABLE = 'equity_snapshots';

/**
 * Hard cap on the snapshot write. Best-effort must mean NON-BLOCKING: a request
 * that HANGS (rather than rejects) would never reach the catch and would keep the
 * cycle pending until the scheduler's whole budget elapsed. Mirrors the Telegram
 * best-effort timeout (alerting/telegram.ts). AbortSignal.timeout is unref'd, so
 * it never delays the manual `npm run decide` exit either.
 */
const SNAPSHOT_WRITE_TIMEOUT_MS = 5_000;

/** One open position in a snapshot's composition (plain numbers — see below). */
interface SnapshotPosition {
  asset: string;
  qty: number;
  /** Valuation price used this wake-up (market_context, or avgCost if stale). */
  price: number;
  value_usd: number;
  /** True when the asset had no live price and was valued at avg cost. */
  price_stale: boolean;
}

/**
 * A snapshot row ready to insert. Unlike the ledger, these are NOT exact `numeric`
 * Decimals: a snapshot is an OBSERVABILITY photo that only ever gets plotted, so we
 * serialize to plain rounded JS numbers (cents / 8-dp qty) — matching how the same
 * portfolio is already written into decisions.market_context, and what the curve
 * reads back cleanly. The exact-Decimal accounting stays in the executions ledger.
 */
export interface EquitySnapshotInsert {
  decision_id: number;
  equity_usd: number;
  cash_usd: number;
  reserve_asset: string;
  positions: SnapshotPosition[];
}

// Same rounding as the portfolio view fed to the LLM / stored in market_context
// (src/decision/context.ts): money at 2 dp, quantities at 8 dp.
const n2 = (d: Decimal): number => Number(d.toFixed(2));
const n8 = (d: Decimal): number => Number(d.toFixed(8));

/**
 * Projects the already-derived virtual portfolio into a snapshot row. Pure: it
 * reuses the existing derivation's output (equity, cash, valued positions) — no
 * re-derivation, no second source of prices, no parallel accounting.
 */
export function buildEquitySnapshot(
  decisionId: number,
  portfolio: VirtualPortfolio,
): EquitySnapshotInsert {
  return {
    decision_id: decisionId,
    equity_usd: n2(portfolio.equity),
    cash_usd: n2(portfolio.cash),
    reserve_asset: portfolio.reserveAsset,
    positions: portfolio.positions.map((pos) => ({
      asset: pos.asset,
      qty: n8(pos.qty),
      price: n2(pos.price),
      value_usd: n2(pos.value),
      price_stale: pos.priceStale,
    })),
  };
}

/**
 * Writes ONE equity photo for a wake-up — best-effort, never blocking.
 *
 * This is OBSERVABILITY, not trading: same posture as the Telegram / Healthchecks
 * calls in the beat. It NEVER throws, and NEVER blocks the cycle — the write is
 * bounded by a short abort timeout, so even a HUNG request can't stall it — and a
 * failed/timed-out write is logged and swallowed. A missed snapshot is a missing
 * curve point, never a missed or rolled-back trade, nor a poisoned cycle outcome;
 * its fate is deliberately decoupled from the decision's and the execution's.
 *
 * Skips silently when there is no durable decision to attach the photo to (no
 * Supabase client, or the decision insert failed → no id): a snapshot is 1:1 with
 * a `decisions` row, so without an id there is nothing to key it to. The DB's
 * UNIQUE(decision_id) is the backstop against a double photo of the same wake-up.
 */
export async function recordEquitySnapshot(
  supabase: SupabaseClient | null,
  decisionId: number | null,
  portfolio: VirtualPortfolio,
): Promise<void> {
  if (!supabase || decisionId == null) return;
  try {
    const { error } = await supabase
      .from(TABLE)
      .insert(buildEquitySnapshot(decisionId, portfolio))
      // Abort a hung write so it can't burn the cycle budget (= block the cycle and
      // misclassify an already-committed decision/trade as a timeout error).
      .abortSignal(AbortSignal.timeout(SNAPSHOT_WRITE_TIMEOUT_MS));
    if (error) throw new Error(error.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] equity snapshot not written for decision #${decisionId} (${msg}) — ` +
        'best-effort, cycle continues.',
    );
  }
}
