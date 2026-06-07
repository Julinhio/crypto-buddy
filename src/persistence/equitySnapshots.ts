import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decimal } from '../money.js';
import type { DecisionStatus } from './decisions.js';
import type { VirtualPortfolio } from '../portfolio/derive.js';

const TABLE = 'equity_snapshots';

/**
 * Hard cap on the snapshot write. The write already lives OUTSIDE the timed cycle
 * (see writeEquitySnapshot), so it can never weigh on the cycle verdict; this
 * timeout is the second guarantee — that the photo gets a bounded window to write
 * before the one-shot beat / CLI process exits, rather than hanging it. Mirrors the
 * Telegram best-effort timeout (alerting/telegram.ts). AbortSignal.timeout is
 * unref'd on Node 22, so it never delays a clean process exit either.
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
 * Decides whether a wake-up warrants a photo and, if so, BUILDS it — PURE, no I/O,
 * so it is safe to run anywhere, including inside the timed cycle. This is the ONE
 * place that encodes "which wake-ups get a snapshot":
 *   - `skipped`  = empty universe = no prices  → no photo;
 *   - a cycle that timed out / threw before returning a valued book (portfolio
 *     null), or a decision that wasn't persisted (no id) → nothing to key a photo
 *     to → no photo;
 *   - `decided` / `error` / `parse_failed` (all past the empty-universe guard, so
 *     the book IS valued) → a photo.
 * The actual write (writeEquitySnapshot) is then done OUTSIDE the cycle.
 */
export function prepareEquitySnapshot(
  status: DecisionStatus,
  decisionId: number | null,
  portfolio: VirtualPortfolio | null,
): EquitySnapshotInsert | null {
  if (status === 'skipped' || decisionId == null || portfolio == null) return null;
  return buildEquitySnapshot(decisionId, portfolio);
}

/**
 * Writes ONE prepared equity photo — best-effort, and the ONLY part of the snapshot
 * path that performs I/O. It is called STRICTLY OUTSIDE the promise whose result
 * determines the cycle's success/failure (beat.ts after the beat's real work, or
 * the CLI after the cycle), so a slow or hung write can NEVER lose the cycle's
 * timeout race, flip a committed cycle to an error, or trigger backoff/alerts. Same
 * best-effort tier as the Telegram / Healthchecks calls.
 *
 * No-ops on a null snapshot (the wake-up didn't warrant one — see
 * prepareEquitySnapshot) or a missing client. It NEVER throws; a failed or
 * timed-out write is logged and swallowed. A missed snapshot is a missing curve
 * point, never a missed/rolled-back trade nor a poisoned cycle outcome. The DB's
 * UNIQUE(decision_id) is the backstop against a double photo of the same wake-up.
 */
export async function writeEquitySnapshot(
  supabase: SupabaseClient | null,
  snapshot: EquitySnapshotInsert | null,
): Promise<void> {
  if (!supabase || snapshot == null) return;
  try {
    const { error } = await supabase
      .from(TABLE)
      .insert(snapshot)
      // Bound the write so even a HUNG request can't stall the one-shot process
      // before it exits (the write is already off the cycle's critical path).
      .abortSignal(AbortSignal.timeout(SNAPSHOT_WRITE_TIMEOUT_MS));
    if (error) throw new Error(error.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] equity snapshot not written for decision #${snapshot.decision_id} (${msg}) — ` +
        'best-effort, ignored.',
    );
  }
}
