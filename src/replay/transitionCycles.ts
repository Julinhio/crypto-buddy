import type { SupabaseClient } from '@supabase/supabase-js';
import { config, tradableBaseAssets } from '../config/index.js';
import { Decimal, ZERO, dec } from '../money.js';
import { nextPositionState, type PositionState } from '../portfolio/lifecycle.js';
import type { AssetRegime } from '../market/regime.js';

/**
 * THE CYCLE STREAM — every wake-up the bot ever had, rebuilt from what it journaled,
 * in order, with the position lifecycle replayed on top.
 *
 * Shared by the order replay (bloc B) and the stop calibration (bloc C) for the same
 * reason `storedCycle.ts` is shared by the two coherence harnesses: if each bloc
 * rebuilt the tape slightly differently, they would be measuring their own
 * reconstructions rather than the same history, and their numbers could not be read
 * side by side.
 *
 * STRICTLY READ-ONLY. It selects from `decisions` and `executions` and writes nothing,
 * anywhere. The bot is running while this executes.
 *
 * Two properties this file exists to hold:
 *
 *  - NO FABRICATION. A missing price stays null, a stale price stays flagged, a cycle
 *    with no journaled regime says so. Nothing is interpolated, defaulted or carried
 *    forward to make a series look complete. The blocs then EXCLUDE what they cannot
 *    measure and report the exclusion, which is the only honest thing to do with a hole.
 *  - THE PEAK IS REPLAYED, NOT INVENTED. `peak_price_since_entry` is overwritten in
 *    place every cycle, so the table holds today's value and no history. The peak each
 *    past cycle held is therefore rebuilt by walking the whole stream through the
 *    UNCHANGED production function (`nextPositionState`) — and then checked, cycle by
 *    cycle, against the 285 peaks the v5 context actually journaled. A reconstruction
 *    that agreed with nothing would be a simulation wearing a replay's clothes.
 */

/** One sovereign booking — the ledger movement, not the testnet order that mirrored it. */
export interface Booking {
  id: number;
  decisionId: number;
  atMs: number;
  asset: string;
  side: 'buy' | 'sell';
  /** Signed base quantity (+ buy / − sell). */
  baseDelta: Decimal;
  /** Signed USDT delta, net of fee. */
  quoteDelta: Decimal;
  valuationPrice: Decimal;
}

/** One asset as a given cycle saw it, BEFORE that cycle's own bookings. */
export interface CycleAsset {
  asset: string;
  qtyBefore: Decimal;
  /**
   * Live unit price at full precision, read from `market.tradable` — NOT from the
   * position view, whose `price` is rounded to 2 decimals for display. On XRP at ~$1.10
   * that rounding is up to 0.9%, which is a sixth of the smallest stop threshold under
   * test; sourcing the stop's input from a display field would have quietly moved
   * triggers on and off. Null when the cycle had no live price for the asset — never a
   * fallback to the cost basis.
   */
  price: Decimal | null;
  /** True when the book had to value this line off its cost basis. */
  priceStale: boolean;
  /** The peak the v5 lifecycle view journaled for this cycle. Null before v5. */
  journaledPeak: Decimal | null;
  journaledDrawdownPercent: number | null;
}

/** What one cycle's regime journal said about one asset. */
export interface CycleRegimeAsset {
  raw: AssetRegime;
  regime: AssetRegime;
  effective: string;
  pendingBars: number;
  pendingRegime: AssetRegime | null;
  pullbackConsumed: boolean | null;
  bounceConsumed: boolean | null;
}

export interface Cycle {
  id: number;
  /** Row timestamp. */
  atMs: number;
  /** When the CONTEXT was generated — the clock production stamps the lifecycle with. */
  generatedAtMs: number;
  generatedAt: string;
  status: string;
  promptVersion: string;
  equity: Decimal;
  reserveAsset: string;
  assets: Map<string, CycleAsset>;
  /** The 4h bar this cycle's regime was computed on. Null before the regime column. */
  regimeBarAtMs: number | null;
  /** Per-asset regime journal, or null when this cycle journaled none. */
  regime: Map<string, CycleRegimeAsset> | null;
  /**
   * The CONFIRMED global risk_off posture this cycle journaled — the one after
   * hysteresis, never the raw reading. Null when the cycle journaled no regime.
   *
   * Read rather than recomputed because it is an INPUT to the transition layer's second
   * rung, and the point of a replay is to feed the production function the values the bot
   * actually held.
   */
  riskOff: boolean | null;
  /** Sovereign bookings attributed to this cycle, in id order. */
  bookings: Booking[];
}

/* ── Loading ──────────────────────────────────────────────────────────────── */

const PAGE = 200;

interface RawDecision {
  id: number;
  created_at: string;
  status: string;
  prompt_version: string;
  market_context: unknown;
  regime: unknown;
}

/** Reads a numeric field that may arrive as a string (Postgres `numeric`) or a number. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Every decision row, paged. Deliberately NOT filtered on `status`: production writes
 * the position lifecycle on every path that reached a valued book — a skipped or
 * errored wake-up ratchets the peak exactly like a decided one, because the peak is a
 * property of the MARKET, not of whether the model answered. Replaying only the decided
 * rows would quietly lose highs and understate every drawdown measured against them.
 */
async function loadDecisions(supabase: SupabaseClient, beforeIso: string): Promise<RawDecision[]> {
  const rows: RawDecision[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select('id, created_at, status, prompt_version, market_context, regime')
      .lt('created_at', beforeIso)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`transition replay: could not read decisions (${error.message}).`);
    const page = (data ?? []) as unknown as RawDecision[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * Every SOVEREIGN booking, paged. `validation_status = 'executed'` is the discriminator
 * that matters: the journal holds two rows per movement — the `intent` that moved the
 * virtual book, and the `execution` that mirrors the testnet order and carries a null
 * validation_status. The virtual book is the economic truth here (the testnet is
 * plumbing), so the intent row is the order, and counting both would double every
 * figure in bloc B.
 */
/**
 * Bookings are bounded by `decision_id`, NOT by timestamp.
 *
 * A booking is written after the decision row that produced it — cycle 1163's decision
 * lands at 08:41:02.691 and its BNB sell at 08:41:03.544, a second later. Bounding the
 * journal by the window's upper edge (which IS a decision timestamp) therefore drops the
 * last cycle's own orders while keeping the cycle: bloc B would lose the C6 reference
 * case and quietly report 41 orders instead of 42. A booking belongs to its cycle, so
 * the cycle set is what bounds it.
 */
async function loadBookings(supabase: SupabaseClient, maxDecisionId: number): Promise<Booking[]> {
  const out: Booking[] = [];
  for (let from = 0; ; from += PAGE * 5) {
    const { data, error } = await supabase
      .from('executions')
      .select('id, created_at, decision_id, symbol, side, ledger_base_delta, ledger_quote_delta, valuation_price')
      .eq('validation_status', 'executed')
      .lte('decision_id', maxDecisionId)
      .order('id', { ascending: true })
      .range(from, from + PAGE * 5 - 1);
    if (error) throw new Error(`transition replay: could not read executions (${error.message}).`);
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of page) {
      const asset = String(row.symbol).split('/')[0];
      const baseDelta = num(row.ledger_base_delta);
      const price = num(row.valuation_price);
      if (!asset || baseDelta == null || price == null) continue;
      out.push({
        id: Number(row.id),
        decisionId: Number(row.decision_id),
        atMs: Date.parse(String(row.created_at)),
        asset,
        side: row.side === 'sell' ? 'sell' : 'buy',
        baseDelta: dec(baseDelta),
        quoteDelta: dec(num(row.ledger_quote_delta) ?? 0),
        valuationPrice: dec(price),
      });
    }
    if (page.length < PAGE * 5) break;
  }
  return out;
}

/* ── Shaping ──────────────────────────────────────────────────────────────── */

function parseRegime(journal: unknown): {
  barAtMs: number | null;
  assets: Map<string, CycleRegimeAsset> | null;
  riskOff: boolean | null;
} {
  const nothing = { barAtMs: null, assets: null, riskOff: null };
  if (journal == null || typeof journal !== 'object') return nothing;
  const j = journal as Record<string, unknown>;
  const barAt = typeof j.barAt === 'string' ? Date.parse(j.barAt) : Number.NaN;
  const global = j.global as Record<string, unknown> | undefined;
  const riskOff = typeof global?.riskOff === 'boolean' ? global.riskOff : null;
  const raw = j.assets;
  if (raw == null || typeof raw !== 'object') return nothing;

  const assets = new Map<string, CycleRegimeAsset>();
  for (const [asset, entry] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const signals = (entry.signals ?? {}) as Record<string, unknown>;
    assets.set(asset, {
      raw: entry.raw as AssetRegime,
      regime: entry.regime as AssetRegime,
      effective: String(entry.effective),
      pendingBars: Number(entry.pendingBars ?? 0),
      pendingRegime: (entry.pendingRegime ?? null) as AssetRegime | null,
      pullbackConsumed: typeof signals.pullbackConsumed === 'boolean' ? signals.pullbackConsumed : null,
      bounceConsumed: typeof signals.bounceConsumed === 'boolean' ? signals.bounceConsumed : null,
    });
  }
  return { barAtMs: Number.isFinite(barAt) ? barAt : null, assets, riskOff };
}

/**
 * Assembles the ordered cycle stream. A row whose context carries no portfolio is
 * dropped and counted (`skippedNoBook`) rather than defaulted to an empty book: an
 * empty book is indistinguishable from "holds nothing", which would read as a full
 * exit and reset every peak.
 */
export function toCycles(
  decisions: RawDecision[],
  bookings: Booking[],
): { cycles: Cycle[]; skippedNoBook: number } {
  const byDecision = new Map<number, Booking[]>();
  for (const b of bookings) {
    const list = byDecision.get(b.decisionId);
    if (list) list.push(b);
    else byDecision.set(b.decisionId, [b]);
  }

  const cycles: Cycle[] = [];
  let skippedNoBook = 0;

  for (const row of decisions) {
    const ctx = row.market_context as Record<string, unknown> | null;
    const account = ctx?.account as Record<string, unknown> | undefined;
    const portfolio = account?.portfolio as Record<string, unknown> | undefined;
    if (portfolio == null) {
      skippedNoBook += 1;
      continue;
    }

    const generatedAt = typeof ctx?.generatedAt === 'string' ? ctx.generatedAt : row.created_at;

    // The lifecycle view the v5 context showed the model — the ONLY journaled record of
    // what the peak was at that moment. Absent under v4, which is why the peak is also
    // replayed and the two are then reconciled.
    const lifecycleView = new Map<string, { peak: number | null; drawdown: number | null }>();
    for (const entry of (ctx?.positions ?? []) as Array<Record<string, unknown>>) {
      lifecycleView.set(String(entry.asset), {
        peak: num(entry.peakPriceSinceEntry),
        drawdown: num(entry.drawdownFromPeakPercent),
      });
    }

    // Prices at full precision, from the market half of the context.
    const marketPrice = new Map<string, Decimal>();
    const market = ctx?.market as Record<string, unknown> | undefined;
    for (const kind of ['tradable', 'reference'] as const) {
      for (const pair of (market?.[kind] ?? []) as Array<Record<string, unknown>>) {
        const [base, quote] = String(pair.symbol ?? '').split('/');
        const price = num(pair.price);
        if (base && quote === String(portfolio.reserveAsset ?? 'USDT') && price != null && price > 0) {
          marketPrice.set(base, dec(price));
        }
      }
    }

    const staleness = new Map<string, boolean>();
    const qtyBefore = new Map<string, Decimal>();
    for (const pos of (portfolio.positions ?? []) as Array<Record<string, unknown>>) {
      const asset = String(pos.asset);
      staleness.set(asset, pos.priceStale === true);
      qtyBefore.set(asset, dec(num(pos.qty) ?? 0));
    }

    // The union, not just the held lines: a flat asset is omitted from `positions`
    // entirely, and the cycle that OPENS it needs a price to seed the peak with. Keying
    // only off the position views left the first bar of every new life with a null
    // peak — which is how cycle 1079's XRP entry lost its high-water mark.
    const assets = new Map<string, CycleAsset>();
    for (const asset of new Set([...tradableBaseAssets(config), ...qtyBefore.keys()])) {
      const stale = staleness.get(asset) ?? false;
      const price = marketPrice.get(asset) ?? null;
      const view = lifecycleView.get(asset);
      assets.set(asset, {
        asset,
        qtyBefore: qtyBefore.get(asset) ?? ZERO,
        // A STALE price is not a price. The book falls back to the cost basis to keep
        // valuing the line; using that fallback as a market price would fabricate the
        // drawdown the stop turns on, at exactly the moment it might fire.
        price: stale ? null : price,
        priceStale: stale,
        journaledPeak: view?.peak == null ? null : dec(view.peak),
        journaledDrawdownPercent: view?.drawdown ?? null,
      });
    }

    const { barAtMs, assets: regime, riskOff } = parseRegime(row.regime);

    cycles.push({
      id: row.id,
      atMs: Date.parse(row.created_at),
      generatedAtMs: Date.parse(generatedAt),
      generatedAt,
      status: row.status,
      promptVersion: row.prompt_version,
      equity: dec(num(portfolio.equity) ?? 0),
      reserveAsset: String(portfolio.reserveAsset ?? 'USDT'),
      assets,
      regimeBarAtMs: barAtMs,
      regime,
      riskOff,
      bookings: (byDecision.get(row.id) ?? []).sort((a, b) => a.id - b.id),
    });
  }

  return { cycles, skippedNoBook };
}

/**
 * The whole cycle stream, BOUNDED to the observation window that was captured earlier in
 * the run.
 *
 * The bound is not defensive tidiness, it is required by the working conditions. The bot
 * is running while this harness executes — that is deliberate, it keeps producing corpus
 * — so a wake-up committed between `loadObservationWindow()` and this call would land in
 * blocs B and C while bloc A, the header count and `window.toMs` all describe the earlier
 * snapshot. The validations would not catch it either: T1 simply skips a cycle whose 4h
 * bar is absent from the replayed timeline, so every check would pass on two populations
 * that do not describe the same period.
 *
 * `arrivedDuringTheRun` reports how many rows the bound excluded, so the reader can see
 * the race happen rather than infer it.
 */
export async function loadCycleStream(
  supabase: SupabaseClient,
  untilMs: number,
): Promise<{
  cycles: Cycle[];
  bookings: Booking[];
  skippedNoBook: number;
  arrivedDuringTheRun: number;
}> {
  // Postgres `timestamptz` keeps MICROSECONDS; a JS Date keeps milliseconds. Bounding
  // with `<= new Date(untilMs).toISOString()` therefore truncates .691152 to .691 and
  // drops the very row the window's upper bound was read from — silently losing the last
  // cycle and its bookings. So the bound is exclusive at the next whole millisecond,
  // which admits every sub-millisecond instant inside `untilMs` and nothing after it.
  const beforeIso = new Date(untilMs + 1).toISOString();
  const decisions = await loadDecisions(supabase, beforeIso);
  const maxDecisionId = decisions.reduce((m, d) => (d.id > m ? d.id : m), 0);
  const bookings = await loadBookings(supabase, maxDecisionId);
  const { cycles, skippedNoBook } = toCycles(decisions, bookings);

  const { count } = await supabase
    .from('decisions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', beforeIso);

  return { cycles, bookings, skippedNoBook, arrivedDuringTheRun: count ?? 0 };
}

/* ── The peak, replayed ───────────────────────────────────────────────────── */

/** The lifecycle state of every tradable asset as of one cycle, AFTER its bookings. */
export interface LifecycleSnapshot {
  cycleId: number;
  states: Map<string, PositionState>;
}

export interface PeakReplay {
  /** One snapshot per cycle, in order. */
  snapshots: LifecycleSnapshot[];
  /** The state after the last cycle — comparable to the live `position_state` table. */
  final: Map<string, PositionState>;
}

/**
 * Replays the position lifecycle across the whole stream through the UNCHANGED
 * production function.
 *
 * The quantity is taken as `qtyBefore + this cycle's bookings`, which is exactly what
 * production feeds it: the context stores the book as it stood at the START of the
 * cycle, and the lifecycle is written at the END, after the movements have booked.
 * Verified on the tape — cycle 1134 held 0.141 BNB, sold 0.054, and cycle 1135's
 * context opens on 0.087.
 */
export function replayPeaks(cycles: Cycle[]): PeakReplay {
  const tradable = tradableBaseAssets(config);
  let previous = new Map<string, PositionState>();
  const snapshots: LifecycleSnapshot[] = [];

  for (const cycle of cycles) {
    const booked = new Map<string, { side: 'buy' | 'sell'; notional: Decimal }>();
    const delta = new Map<string, Decimal>();
    for (const b of cycle.bookings) {
      delta.set(b.asset, (delta.get(b.asset) ?? ZERO).plus(b.baseDelta));
      const notional = b.baseDelta.abs().times(b.valuationPrice);
      const prior = booked.get(b.asset);
      booked.set(
        b.asset,
        prior && prior.side === b.side ? { side: b.side, notional: prior.notional.plus(notional) } : { side: b.side, notional },
      );
    }

    const states = new Map<string, PositionState>();
    for (const asset of tradable) {
      const view = cycle.assets.get(asset);
      const qty = (view?.qtyBefore ?? ZERO).plus(delta.get(asset) ?? ZERO);
      states.set(
        asset,
        nextPositionState({
          asset,
          previous: previous.get(asset) ?? null,
          qty,
          price: view?.price ?? null,
          booked: booked.get(asset) ?? null,
          note: null,
          now: cycle.generatedAt,
        }),
      );
    }

    snapshots.push({ cycleId: cycle.id, states });
    previous = states;
  }

  return { snapshots, final: previous };
}
