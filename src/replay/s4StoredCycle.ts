import { dec, ONE } from '../money.js';
import type { LedgerEntry } from '../persistence/executions.js';
import { derivePortfolio, type VirtualPortfolio } from '../portfolio/derive.js';
import type { S4Line, S4LinePlan } from '../s4/core.js';
import { s4MoveReason, type S4Movement, type S4Report } from '../s4/cycle.js';
import { decidingFromJournal, type S4DecidingClose, type S4JournalRow } from '../s4/motif.js';

/**
 * ONE S4 CYCLE AS THE DATABASE RECORDED IT — and what the display code makes of it.
 *
 * Pure, no I/O. The replay (`replay:display`) reads these rows from production, read-only; the
 * offline test (`test/displayReliability.ts`) reads the very same rows from the fixture the
 * replay wrote. Both then run the SAME functions as the live path: `s4MoveReason` for the
 * cause, `prepareS4Notification` / `formatS4Activity` for the text, `buildEquitySnapshot` for
 * the photo. Nothing here re-states what production does.
 *
 * What a decided S4 row holds, and that is all this needs:
 *   - `market_context.book`   the book the cycle read, BEFORE its orders (exact cash, exact
 *                             quantities, the prices the cycle valued it at);
 *   - `market_context.lines`  the S4 lines after the closes, before the fills;
 *   - `market_context.plan`   the engine's plan (weight before, target);
 *   - the booked sovereign intents of that decision (`executions`), which are the fills.
 */

export interface StoredBook {
  cash: number;
  equity: number;
  positions: Array<{ asset: string; qty: string; price: number }>;
}

/** A booked sovereign intent (`event_type='intent'`, `validation_status='executed'`). */
export interface StoredIntent {
  id: number;
  symbol: string;
  side: 'buy' | 'sell';
  valuation_price: string | number;
  ledger_base_delta: string | number;
  ledger_quote_delta: string | number;
  fee: string | number;
}

/** An `equity_snapshots` row, as stored. */
export interface StoredPhoto {
  decision_id: number;
  equity_usd: number;
  cash_usd: number;
  positions: Array<{ asset: string; qty: number; value_usd: number }>;
}

export interface StoredS4Cycle {
  id: number;
  createdAt: string;
  reserveAsset: string;
  pilot: { label: string; firstCycle: boolean; ordersEnabled: boolean };
  closesDecided: string[];
  lines: S4Line[];
  plan: S4LinePlan[];
  book: StoredBook;
  intents: StoredIntent[];
  /** The photo stored for this cycle, and the one stored for the cycle after it. */
  photo: StoredPhoto | null;
  nextPhoto: StoredPhoto | null;
}

/** The journal rows a cycle's movements are keyed to, as PostgREST returned them. */
export interface StoredJournalRow extends S4JournalRow {
  asset: string;
}

export function ledgerOf(intents: readonly StoredIntent[]): LedgerEntry[] {
  return intents.map((i) => ({
    symbol: i.symbol,
    side: i.side,
    valuationPrice: dec(i.valuation_price),
    baseDelta: dec(i.ledger_base_delta),
    quoteDelta: dec(i.ledger_quote_delta),
  }));
}

/**
 * The stored book, optionally moved by booked fills, as the `VirtualPortfolio` production
 * derives: the recorded cash and quantities are replayed as opening entries (a position enters at
 * its recorded price, for no cash), then the fills in order — exactly the deltas `derivePortfolio`
 * applies live — and the whole is valued at the prices the cycle recorded. An asset the cycle
 * opened from flat has no recorded price in the pre-trade book: its fill's valuation price is the
 * price the cycle used.
 */
export function bookWith(book: StoredBook, intents: readonly StoredIntent[], reserveAsset: string): VirtualPortfolio {
  const prices = new Map<string, ReturnType<typeof dec>>();
  for (const i of intents) prices.set(i.symbol.split('/')[0]!, dec(i.valuation_price));
  for (const p of book.positions) prices.set(p.asset, dec(p.price));
  const opening: LedgerEntry[] = book.positions.map((p) => ({
    symbol: `${p.asset}/${reserveAsset}`,
    side: 'buy',
    valuationPrice: dec(p.price),
    baseDelta: dec(p.qty),
    quoteDelta: dec(0),
  }));
  return derivePortfolio([...opening, ...ledgerOf(intents)], {
    startingCapital: dec(book.cash),
    reserveAsset,
    priceOf: (asset) => (asset === reserveAsset ? ONE : (prices.get(asset) ?? null)),
  });
}

/** The legs a cycle booked, each with the cause the live cycle attributes (`s4MoveReason`). */
export function movementsOf(cycle: StoredS4Cycle): S4Movement[] {
  const held = new Map(cycle.book.positions.map((p) => [p.asset, dec(p.qty).gt(0)]));
  const byAsset = new Map<string, S4Movement>();
  for (const e of ledgerOf(cycle.intents)) {
    const asset = e.symbol.split('/')[0]!;
    const side = e.baseDelta.gt(0) ? 'buy' : 'sell';
    const reason = s4MoveReason({
      firstCycle: cycle.pilot.firstCycle,
      side,
      line: cycle.lines.find((l) => l.asset === asset),
      heldBefore: held.get(asset) === true,
    });
    const prev = byAsset.get(asset);
    if (prev) prev.usd += e.quoteDelta.abs().toNumber();
    else byAsset.set(asset, { asset, side, usd: e.quoteDelta.abs().toNumber(), reason });
  }
  return [...byAsset.values()].sort((a, b) => b.usd - a.usd);
}

/**
 * The cycle's report, rebuilt from its row. `events` is left EMPTY on purpose: the values of a
 * deciding close then come from the journal (`s4_close_decisions`), which is what "replayed from
 * the values recorded in the database" means — and what the live path reads when a movement
 * executes a decision taken by an earlier cycle.
 */
export function reportOf(cycle: StoredS4Cycle): S4Report {
  return {
    label: cycle.pilot.label,
    ordersEnabled: cycle.pilot.ordersEnabled,
    firstCycle: cycle.pilot.firstCycle,
    closesDecided: cycle.closesDecided.map((c) => Date.parse(c)),
    events: [],
    lines: cycle.lines,
    linesBefore: cycle.lines,
    linesAtDecision: cycle.lines,
    plan: cycle.plan,
    movements: movementsOf(cycle),
    withheld: [],
    anomalies: [],
    blocked: null,
    nextDelayMinutes: 0,
  };
}

/** The journal, read from stored rows: the offline twin of `readDecidingClose`. */
export function decidingFromRows(rows: readonly StoredJournalRow[], asset: string, kind: 'exit' | 'rebuy', closeMs: number): S4DecidingClose | null {
  const row = rows.find((r) => r.asset === asset && r.event === kind && Date.parse(r.close_at) === closeMs);
  if (!row) return null;
  const previousOut =
    kind === 'rebuy'
      ? (rows
          .filter((r) => r.asset === asset && r.days_out != null && Date.parse(r.close_at) < closeMs)
          .sort((a, b) => Date.parse(b.close_at) - Date.parse(a.close_at))[0] ?? null)
      : null;
  return decidingFromJournal(row, previousOut);
}

export function feesOf(intents: readonly StoredIntent[]): number {
  return intents.reduce((sum, i) => sum.plus(dec(i.fee)), dec(0)).toNumber();
}
