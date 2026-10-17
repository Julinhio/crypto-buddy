import { Decimal, ZERO } from '../../money.js';
import { planMovements, type SuppressedLeg } from '../../execution/movements.js';
import type { PositionView, VirtualPortfolio } from '../../portfolio/derive.js';

/**
 * EXECUTION — production's `planMovements`, on a book valued at the bar's OPEN.
 *
 * The PR #36 bench bought line by line in alphabetical order, each taking `min(delta, cash)`.
 * At 70 % exposure there was cash left; at 100 % the fees and slippage of the sells are
 * always missing at the end, and XRP, last in the order, would have been underweighted on
 * every rebalance. Production splits its buy budget PRO RATA and re-checks the plumbing floor
 * on each share without redistributing what it drops. This module calls that function rather
 * than restating it.
 *
 * ── WHAT IS ADDED ON TOP, AND WHY IT CANNOT CHANGE THE PLAN ───────────────────────────
 *
 * Production books at the mainnet price without slippage. The bench keeps PR #36's constant
 * slippage (0.05 % per leg): a sell receives `open × (1 − s)`, a buy pays `open × (1 + s)`.
 * The plan is sized without it, exactly as production sizes it; slippage then lowers what a
 * sell brings in and what a buy receives. A plan whose buys were funded by sells that brought
 * in less than planned is scaled down pro rata to the cash really there — the book never
 * finances itself with negative cash. Both effects are counted and published.
 *
 * ── `planMovements` LOGS ───────────────────────────────────────────────────────────────
 *
 * It prints a `[skip]` line for every leg it drops, which is right for a live cycle and
 * unreadable over twelve thousand bars. The bench silences `console.log`/`console.warn` for the
 * duration of the call only, and reads the drops from the plan's own `suppressed` list.
 */

export interface BookLine {
  qty: Decimal;
}

export interface FillReport {
  /** Gross notional traded (sells + buys), at the plan's price. */
  tradedNotional: Decimal;
  fees: Decimal;
  /** Cost of slippage, in quote. */
  slippageCost: Decimal;
  /** Legs production's planner dropped: `reliquat_inexecutable` and its siblings. */
  suppressed: SuppressedLeg[];
  /** Assets that were sold to zero by this execution. */
  closedOut: string[];
  /** Assets that went from zero to positive. */
  opened: string[];
  /** `available / planned` when the buys had to be scaled down, else 1. */
  buyScale: number;
}

function silently<T>(fn: () => T): T {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** A `VirtualPortfolio` for the planner, from the bench's book at the given prices. */
export function bookAsPortfolio(
  cash: Decimal,
  positions: Readonly<Record<string, BookLine>>,
  prices: Readonly<Record<string, Decimal>>,
  reserveAsset: string,
): VirtualPortfolio {
  let deployed = ZERO;
  const views: PositionView[] = [];
  for (const [asset, line] of Object.entries(positions)) {
    if (!line.qty.gt(0)) continue;
    const price = prices[asset];
    if (price == null) throw new Error(`bench execute: no price for held ${asset}`);
    const value = line.qty.times(price);
    deployed = deployed.plus(value);
    views.push({
      asset,
      qty: line.qty,
      avgCost: price,
      price,
      priceStale: false,
      value,
      unrealizedPnl: ZERO,
      weightPercent: ZERO,
    });
  }
  const equity = cash.plus(deployed);
  for (const v of views) v.weightPercent = equity.gt(0) ? v.value.div(equity).times(100) : ZERO;
  return {
    reserveAsset,
    startingCapital: equity,
    cash,
    positions: views,
    equity,
    deployedPercent: equity.gt(0) ? deployed.div(equity).times(100) : ZERO,
    realizedPnl: ZERO,
    unrealizedPnl: ZERO,
    totalPnl: ZERO,
  };
}

/**
 * Executes a target allocation (percent of equity per asset, reserve derived) at `prices`.
 * Mutates `book` and returns the new cash.
 */
export function executeAllocation(params: {
  cash: Decimal;
  book: Record<string, BookLine>;
  prices: Readonly<Record<string, Decimal>>;
  /** Per asset: the weight to pursue, in percent of equity at `prices`. */
  targets: Readonly<Record<string, number>>;
  reserveAsset: string;
  feePercent: number;
  slippagePercent: number;
  minMovementPercent: number;
}): { cash: Decimal; report: FillReport } {
  const { book, prices, targets, reserveAsset } = params;
  const portfolio = bookAsPortfolio(params.cash, book, prices, reserveAsset);

  const allocation: Record<string, number> = {};
  let risky = 0;
  for (const [asset, pct] of Object.entries(targets)) {
    allocation[asset] = pct;
    risky += pct;
  }
  // The reserve is derived, never carried. A held line re-valued at the open can push the sum
  // a hair above 100; the reserve is then 0, and the cash really there bounds the buys below.
  allocation[reserveAsset] = Math.max(0, 100 - risky);

  const held = new Set(Object.entries(book).filter(([, l]) => l.qty.gt(0)).map(([a]) => a));
  const plan = silently(() =>
    planMovements(portfolio, allocation, (asset) => prices[asset] ?? null, params.feePercent, params.minMovementPercent, ' bench'),
  );

  const slip = new Decimal(params.slippagePercent).div(100);
  let cash = params.cash;
  let traded = ZERO;
  let fees = ZERO;
  let slippageCost = ZERO;
  const closedOut: string[] = [];
  const opened: string[] = [];

  // ── SELLS first: a book cannot spend what it has not raised ───────────────────────
  for (const m of plan.movements.filter((x) => x.side === 'sell')) {
    const line = book[m.asset]!;
    // A full exit sells the quantity HELD, exactly — never a recomputed one with a residue.
    const qty = m.fullExit ? line.qty : Decimal.min(m.qty, line.qty);
    const gross = qty.times(m.price);
    const slipped = gross.times(slip);
    const fee = gross.times(params.feePercent).div(100);
    cash = cash.plus(gross).minus(slipped).minus(fee);
    line.qty = line.qty.minus(qty);
    if (line.qty.lte(new Decimal('1e-12'))) {
      line.qty = ZERO;
      closedOut.push(m.asset);
    }
    traded = traded.plus(gross);
    fees = fees.plus(fee);
    slippageCost = slippageCost.plus(slipped);
  }

  // ── BUYS, pro rata as planned, scaled down if the slipped sells fell short ────────
  const buys = plan.movements.filter((x) => x.side === 'buy');
  const plannedOutlay = buys.reduce((s, m) => s.plus(m.notional).plus(m.fee), ZERO);
  const buyScale = plannedOutlay.gt(cash) && plannedOutlay.gt(0) ? Decimal.max(cash, ZERO).div(plannedOutlay) : new Decimal(1);
  for (const m of buys) {
    const notional = m.notional.times(buyScale);
    const fee = notional.times(params.feePercent).div(100);
    const unitPrice = m.price.times(new Decimal(1).plus(slip));
    const qty = notional.div(unitPrice);
    book[m.asset] ??= { qty: ZERO };
    if (!held.has(m.asset) && qty.gt(0)) opened.push(m.asset);
    book[m.asset]!.qty = book[m.asset]!.qty.plus(qty);
    cash = cash.minus(notional).minus(fee);
    traded = traded.plus(notional);
    fees = fees.plus(fee);
    slippageCost = slippageCost.plus(qty.times(m.price.times(slip)));
  }
  if (cash.lt(new Decimal('-1e-9'))) throw new Error(`bench execute: cash went negative (${cash.toString()})`);
  if (cash.lt(0)) cash = ZERO;

  return {
    cash,
    report: {
      tradedNotional: traded,
      fees,
      slippageCost,
      suppressed: plan.suppressed,
      closedOut,
      opened,
      buyScale: buyScale.toNumber(),
    },
  };
}
