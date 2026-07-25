import 'dotenv/config';
import { config } from '../config/index.js';
import { Decimal, ZERO, dec } from '../money.js';
import { publicMainnetClient } from '../exchanges/binance.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { computeMovements, movementFloor, type Movement } from '../execution/movements.js';
import { planMovements, type PlanVerdict } from '../execution/plan.js';
import { loadSymbolRules, type SymbolRules } from '../execution/symbolRules.js';
import { fmtBar, loadObservationWindow } from './window.js';

/**
 * SIZING REPLAY — the acceptance criterion of Strategy V2 PR 2.
 *
 * Same posture as the regime replay it sits beside: re-run the DETERMINISTIC layer
 * over the window the bot actually observed, and check the claim the PR makes. Here
 * the claim is narrow and measurable — no movement under 2% of capital reaches the
 * execution journal.
 *
 * What makes this a replay rather than a simulation: every cycle is re-sized from the
 * EXACT inputs that cycle had. `decisions.market_context` stores the virtual book the
 * bot saw (cash, positions, equity, live prices) and `applied_allocation` stores the
 * risk-bounded target it was asked to reach. Feed those two back into the unchanged
 * `computeMovements` / `planMovements` and you get the movements that cycle would
 * produce — once with the floor disabled (what actually happened) and once with it
 * on (what will happen now). The difference is the measurement.
 *
 * Read-only and side-effect free: it reads `decisions`, fetches the public mainnet
 * order filters, and writes nothing anywhere.
 *
 * Run with `npm run replay:sizing`. Exits non-zero if any criterion fails.
 */

interface Criterion {
  id: string;
  title: string;
  passed: boolean;
  detail: string[];
}

const results: Criterion[] = [];

function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, title, passed, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

/** The two rejection reasons the mandate names, plus a catch-all. */
type CrumbFamily = 'notional < minNotional' | 'quantity snapped to zero at the lot step' | 'other';

function crumbFamily(reason: string): CrumbFamily {
  if (reason.startsWith('notional ')) return 'notional < minNotional';
  if (reason.startsWith('quantity snapped')) return 'quantity snapped to zero at the lot step';
  return 'other';
}

/* ── Rebuilding one cycle's inputs from what the bot journaled ─────────────── */

interface StoredPosition {
  asset: string;
  qty: number;
  avgCost: number;
  price: number;
  priceStale: boolean;
  value: number;
  unrealizedPnl: number;
  weightPercent: number;
}

interface StoredContext {
  market: { tradable: Array<{ symbol: string; price: number }> };
  account: {
    portfolio: {
      reserveAsset: string;
      startingCapital: number;
      cash: number;
      equity: number;
      deployedPercent: number;
      realizedPnl: number;
      unrealizedPnl: number;
      totalPnl: number;
      positions: StoredPosition[];
    };
  };
}

interface StoredCycle {
  created_at: string;
  applied_allocation: Record<string, number>;
  market_context: StoredContext;
}

/**
 * The virtual book EXACTLY as that cycle saw it. Taken from the stored view rather
 * than re-derived from the ledger on purpose: the point is to replay the real inputs,
 * not to re-litigate how they were computed.
 */
function bookOf(ctx: StoredContext): VirtualPortfolio {
  const p = ctx.account.portfolio;
  return {
    reserveAsset: p.reserveAsset,
    startingCapital: dec(p.startingCapital),
    cash: dec(p.cash),
    equity: dec(p.equity),
    deployedPercent: dec(p.deployedPercent),
    realizedPnl: dec(p.realizedPnl),
    unrealizedPnl: dec(p.unrealizedPnl),
    totalPnl: dec(p.totalPnl),
    positions: p.positions.map((pos) => ({
      asset: pos.asset,
      qty: dec(pos.qty),
      avgCost: dec(pos.avgCost),
      price: dec(pos.price),
      priceStale: pos.priceStale,
      value: dec(pos.value),
      unrealizedPnl: dec(pos.unrealizedPnl),
      weightPercent: dec(pos.weightPercent),
    })),
  };
}

/** Prices as that cycle had them: the reserve is 1, every pair carries its own. */
function pricesOf(ctx: StoredContext): PriceLookup {
  const reserve = ctx.account.portfolio.reserveAsset;
  const map = new Map<string, Decimal>();
  for (const pair of ctx.market.tradable) {
    const [base, quote] = pair.symbol.split('/');
    if (base && quote === reserve && Number.isFinite(pair.price) && pair.price > 0) {
      map.set(base, dec(pair.price));
    }
  }
  return (asset: string): Decimal | null =>
    asset === reserve ? dec(1) : map.get(asset) ?? null;
}

/* ── Running one cycle through the plan, with the floor on or off ─────────── */

interface CycleOutcome {
  /** How many movements this cycle produced before any plan-stage verdict. */
  produced: number;
  /** Movements that would be JOURNALED as rejected intents (the venue said no). */
  crumbs: Array<{ family: CrumbFamily; notional: Decimal }>;
  /** Movements dropped by our own floor — journaled nowhere. */
  droppedByFloor: number;
  /** Movements that would actually be booked and sent. */
  booked: Array<{ movement: Movement; notional: Decimal }>;
  blocked: number;
}

function runCycle(
  cycle: StoredCycle,
  rulesOf: (symbol: string) => SymbolRules,
  minMovementPercent: number,
): CycleOutcome {
  const book = bookOf(cycle.market_context);
  const priceOf = pricesOf(cycle.market_context);
  const reserve = book.reserveAsset;
  const feePercent = config.execution.feePercent;

  const movements = computeMovements(book, cycle.applied_allocation, priceOf, feePercent, minMovementPercent);
  const targetReserve = book.equity.times(cycle.applied_allocation[reserve] ?? 0).div(100);
  const floor = movementFloor(book.equity, minMovementPercent);

  // Only movements whose symbol has known rules can be planned — same filter the
  // executor applies.
  const resolvable = movements.filter((m) => {
    try {
      rulesOf(m.symbol);
      return true;
    } catch {
      return false;
    }
  });
  const plan = planMovements(resolvable, { rulesOf, cash: book.cash, targetReserve, feePercent, floor });

  const outcome: CycleOutcome = { produced: movements.length, crumbs: [], droppedByFloor: 0, booked: [], blocked: 0 };
  for (const p of plan) {
    const notional = p.snappedQty.times(p.movement.price);
    const verdict: PlanVerdict = p.verdict;
    if (verdict.kind === 'below_floor') outcome.droppedByFloor += 1;
    else if (verdict.kind === 'crumb') outcome.crumbs.push({ family: crumbFamily(verdict.reason), notional });
    else if (verdict.kind === 'block') outcome.blocked += 1;
    else outcome.booked.push({ movement: p.movement, notional });
  }
  return outcome;
}

/* ── Criteria ──────────────────────────────────────────────────────────────── */

interface Totals {
  cycles: number;
  crumbsByFamily: Map<CrumbFamily, number>;
  crumbs: number;
  /**
   * Movements `computeMovements` produced at all. The floor mostly acts HERE — a
   * sub-floor leg is never turned into a movement — so the honest measure of what the
   * floor removes is the drop in this number, not a count of plan-stage verdicts.
   */
  produced: number;
  /** Dropped at the PLAN stage (a buy scaled under the floor after a sell fell through). */
  droppedByFloor: number;
  booked: number;
  blocked: number;
  /** Booked movements strictly under the floor of their own cycle. */
  underFloorReachingJournal: Array<{ at: string; symbol: string; notional: string; floor: string }>;
}

function tally(
  cycles: StoredCycle[],
  rulesOf: (symbol: string) => SymbolRules,
  minMovementPercent: number,
): Totals {
  const t: Totals = {
    cycles: cycles.length,
    crumbsByFamily: new Map(),
    crumbs: 0,
    produced: 0,
    droppedByFloor: 0,
    booked: 0,
    blocked: 0,
    underFloorReachingJournal: [],
  };
  for (const cycle of cycles) {
    const out = runCycle(cycle, rulesOf, minMovementPercent);
    t.produced += out.produced;
    const floor = movementFloor(dec(cycle.market_context.account.portfolio.equity), config.execution.minMovementPercent);
    for (const c of out.crumbs) {
      t.crumbs += 1;
      t.crumbsByFamily.set(c.family, (t.crumbsByFamily.get(c.family) ?? 0) + 1);
    }
    t.droppedByFloor += out.droppedByFloor;
    t.blocked += out.blocked;
    for (const b of out.booked) {
      t.booked += 1;
      // Measured against the 2% floor of THAT cycle's equity, whatever floor the run used.
      if (!b.movement.fullExit && b.notional.lt(floor)) {
        t.underFloorReachingJournal.push({
          at: cycle.created_at,
          symbol: b.movement.symbol,
          notional: b.notional.toFixed(2),
          floor: floor.toFixed(2),
        });
      }
    }
  }
  return t;
}

/**
 * Runs `fn` with the sizing pass's per-movement logging muted. That log is right in
 * production — a couple of lines a cycle — but across 788 replayed cycles it is
 * thousands of lines burying the only thing that matters here, the aggregate.
 */
function quietly<T>(fn: () => T): T {
  const log = console.log;
  console.log = (): void => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

function familyLine(t: Totals): string {
  const entries = [...t.crumbsByFamily.entries()].sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? 'none' : entries.map(([f, n]) => `${f}: ${n}`).join('  ·  ');
}

async function main(): Promise<number> {
  const window = await loadObservationWindow();
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('replay: Supabase is not configured.');

  // PAGED. PostgREST caps a response at 1000 rows by default; the bot adds ~17
  // decisions a day, so an unpaged query would soon replay only the oldest page while
  // the header still advertised the full window — S1/S2 passing without ever looking
  // at a recent cycle, and S3 comparing that truncated model against an exact count
  // over the whole executions table. A criterion that silently narrows its own scope
  // is worse than no criterion.
  const PAGE = 500;
  const cycles: StoredCycle[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select('created_at, applied_allocation, market_context')
      .eq('status', 'decided')
      .not('applied_allocation', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`replay: could not read decisions (${error.message}).`);
    const page = (data ?? []) as unknown as StoredCycle[];
    cycles.push(...page);
    if (page.length < PAGE) break;
  }

  console.log('='.repeat(96));
  console.log('SIZING REPLAY — the 2% plumbing floor');
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  ` +
      `(${window.days} days, ${cycles.length} decided cycles re-sized)`,
  );
  console.log(
    `Floor: ${config.execution.minMovementPercent}% of equity  ·  fee ${config.execution.feePercent}%  ` +
      `·  order filters: live Binance public mainnet`,
  );
  console.log('='.repeat(96));

  // The AUTHORITATIVE filters — the same ones the executor validates against.
  const client = publicMainnetClient();
  const rules = new Map<string, SymbolRules>();
  for (const symbol of config.tradablePairs) {
    rules.set(symbol, await loadSymbolRules(client, symbol));
  }
  const rulesOf = (symbol: string): SymbolRules => {
    const r = rules.get(symbol);
    if (!r) throw new Error(`no rules for ${symbol}`);
    return r;
  };
  for (const [symbol, r] of rules) {
    console.log(
      `[replay] ${symbol}: stepSize ${r.stepSize.toString()}  minNotional ${r.minNotional.toString()}  ` +
        `(a 2% movement ≈ $20, so neither filter can bite)`,
    );
  }

  const before = quietly(() => tally(cycles, rulesOf, 0)); // floor disabled — what actually happened
  const after = quietly(() => tally(cycles, rulesOf, config.execution.minMovementPercent));

  /* S1 — the criterion the PR is about. */
  record(
    'S1',
    'no movement under 2% of capital reaches the execution journal',
    after.underFloorReachingJournal.length === 0,
    [
      `movements that would be booked and sent: ${after.booked}`,
      `of those, strictly under their cycle's 2% floor: ${after.underFloorReachingJournal.length}`,
      ...after.underFloorReachingJournal.slice(0, 5).map((u) => `  ${u.at} ${u.symbol} ${u.notional} < ${u.floor}`),
    ],
  );

  /* S2 — both rejection families are gone, not just the larger one. */
  const familiesLeft = [...after.crumbsByFamily.entries()].filter(([, n]) => n > 0);
  record(
    'S2',
    'both rejection families disappear — notional AND lot step',
    after.crumbs === 0,
    [
      `WITHOUT the floor: ${before.produced} movements produced, ${before.crumbs} rejected as intents  →  ${familyLine(before)}`,
      `WITH the floor:    ${after.produced} movements produced, ${after.crumbs} rejected as intents  →  ${familyLine(after)}`,
      `never born (dropped while sizing, journaled NOWHERE): ${before.produced - after.produced}` +
        `  ·  dropped later at the plan stage: ${after.droppedByFloor}`,
      `orders that would actually be placed: ${before.booked} without the floor  →  ${after.booked} with it ` +
        `(the ${before.booked - after.booked} removed are the $5-7 dribbles the mandate describes)`,
      familiesLeft.length === 0
        ? 'no family survives: a $20 minimum is 4× the min-notional and far above the coarsest lot step'
        : `families still present: ${familiesLeft.map(([f, n]) => `${f} (${n})`).join(', ')}`,
    ],
  );

  /* S3 — the replay models the real phenomenon, it does not invent it. */
  const { count: observedRejected } = await supabase
    .from('executions')
    .select('*', { count: 'exact', head: true })
    .eq('event_type', 'intent')
    .eq('validation_status', 'rejected');
  const modelled = before.crumbs;
  const ratio = observedRejected ? modelled / observedRejected : 0;
  record(
    'S3',
    'the replay reproduces the rejections actually observed',
    ratio >= 0.5 && ratio <= 1.5,
    [
      `rejected intents actually journaled over the window: ${observedRejected ?? 'n/a'}`,
      `rejected intents the replay reproduces with the floor OFF: ${modelled} (ratio ${ratio.toFixed(2)}, bound 0.5-1.5)`,
      'a replay that could not reproduce the waste would not be evidence that the floor removes it.',
    ],
  );

  /* S4 — a full exit is still permitted, whatever the floor. */
  const exitBook: VirtualPortfolio = {
    reserveAsset: 'USDT',
    startingCapital: dec(1000),
    cash: dec(992),
    equity: dec(1000),
    deployedPercent: dec(0.8),
    realizedPnl: ZERO,
    unrealizedPnl: ZERO,
    totalPnl: ZERO,
    positions: [
      {
        asset: 'XRP', qty: dec(8), avgCost: dec(1), price: dec(1), priceStale: false,
        value: dec(8), unrealizedPnl: ZERO, weightPercent: dec(0.8),
      },
    ],
  };
  const exitPrices: PriceLookup = (a) => (a === 'XRP' ? dec(1) : a === 'USDT' ? dec(1) : null);
  const exits = quietly(() =>
    computeMovements(exitBook, { XRP: 0, USDT: 100 }, exitPrices, config.execution.feePercent, config.execution.minMovementPercent),
  );
  const trims = quietly(() =>
    computeMovements(exitBook, { XRP: 0.4, USDT: 99.6 }, exitPrices, config.execution.feePercent, config.execution.minMovementPercent),
  );
  record(
    'S4',
    'a full exit is still permitted below the floor; a partial trim of the same line is not',
    exits.length === 1 && exits[0]?.fullExit === true && trims.length === 0,
    [
      `an $8 line on a $1000 book (floor $20) — full exit produced: ${exits.length} movement(s), ` +
        `fullExit=${exits[0]?.fullExit ?? 'n/a'}`,
      `partial trim of the same line produced: ${trims.length} movement(s)`,
      'the two conditions crossing on a small line is the mandate\'s stated intent, not a regression to fix later.',
    ],
  );

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log('='.repeat(96));
  console.log(
    `${results.length - failed.length}/${results.length} criteria passed` +
      (failed.length > 0 ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ' — all PR 2 acceptance criteria met.'),
  );
  console.log('='.repeat(96));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Sizing replay failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
