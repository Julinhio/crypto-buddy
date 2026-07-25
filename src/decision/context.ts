import { Decimal, ONE } from '../money.js';
import type { StrategyVersion } from '../config/index.js';
import type { PositionState } from '../portfolio/lifecycle.js';
import type { MarketContext } from '../context/build.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';

/** Readable, plain-number view of the portfolio for the LLM context + the tape. */
export interface PortfolioView {
  reserveAsset: string;
  startingCapital: number;
  cash: number;
  equity: number;
  deployedPercent: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  positions: Array<{
    asset: string;
    qty: number;
    avgCost: number;
    price: number;
    priceStale: boolean;
    value: number;
    unrealizedPnl: number;
    weightPercent: number;
  }>;
}

/**
 * What the LLM actually sees: the market read, but with the bot's VIRTUAL
 * portfolio in place of the raw testnet balances. The testnet basket is inflated
 * and monthly-reset — never the economic source of truth.
 */
/** One position's lifecycle, as the v5 model sees it. Code-owned fields are read-only to it. */
export interface PositionLifecycleView {
  asset: string;
  entryDate: string | null;
  peakPriceSinceEntry: number | null;
  /** How far the current price sits below the peak, in percent (negative or zero). */
  drawdownFromPeakPercent: number | null;
  lastSignificantMoveAt: string | null;
  lastSignificantMoveSide: string | null;
  lastSignificantMoveNotional: number | null;
  thesis: string | null;
  invalidation: string | null;
}

export interface DecisionContext {
  generatedAt: string;
  source: MarketContext['source'];
  market: MarketContext['market'];
  account: { portfolio: PortfolioView };
  /**
   * v5 ONLY. Under v4 both stay absent, which is what makes shadow mode real: the
   * regime and the lifecycle are computed and journaled either way, but the v4 model
   * is shown a context byte-identical to the one it has always seen.
   */
  regime?: MarketContext['regime'];
  positions?: PositionLifecycleView[];
}

const n2 = (d: Decimal): number => Number(d.toFixed(2));
const n8 = (d: Decimal): number => Number(d.toFixed(8));

export function toPortfolioView(p: VirtualPortfolio): PortfolioView {
  return {
    reserveAsset: p.reserveAsset,
    startingCapital: n2(p.startingCapital),
    cash: n2(p.cash),
    equity: n2(p.equity),
    deployedPercent: n2(p.deployedPercent),
    realizedPnl: n2(p.realizedPnl),
    unrealizedPnl: n2(p.unrealizedPnl),
    totalPnl: n2(p.totalPnl),
    positions: p.positions.map((pos) => ({
      asset: pos.asset,
      qty: n8(pos.qty),
      avgCost: n2(pos.avgCost),
      price: n2(pos.price),
      priceStale: pos.priceStale,
      value: n2(pos.value),
      unrealizedPnl: n2(pos.unrealizedPnl),
      weightPercent: n2(pos.weightPercent),
    })),
  };
}

export function toDecisionContext(
  market: MarketContext,
  portfolio: VirtualPortfolio,
  strategy: StrategyVersion = 'v4',
  lifecycle: Map<string, PositionState> = new Map(),
): DecisionContext {
  const base: DecisionContext = {
    generatedAt: market.generatedAt,
    source: market.source,
    market: market.market,
    account: { portfolio: toPortfolioView(portfolio) },
  };
  if (strategy !== 'v5') return base;

  // v5 sees the regime as an established fact, and each position's lifecycle. The
  // drawdown from the peak is precomputed rather than left as arithmetic for the
  // model: it is the number the trailing playbook turns on, and a model doing mental
  // division on two prices is a model that will occasionally get it wrong.
  // Only LIVE prices. `derivePortfolio` falls back to avgCost when a price is missing
  // and flags it `priceStale`; feeding that fallback in here would produce a
  // fabricated drawdown from the peak — a peak-versus-cost-basis number — at exactly
  // the moment the trailing playbook might act on it. No live price, no drawdown.
  const priced = new Map(portfolio.positions.filter((p) => !p.priceStale).map((p) => [p.asset, p.price]));
  const positions: PositionLifecycleView[] = [];
  for (const [asset, state] of lifecycle) {
    if (state.entryDate == null) continue; // flat lines have no lifecycle to show
    const price = priced.get(asset) ?? null;
    // The stored peak is last cycle's. If the live price is ABOVE it, the ratchet has
    // simply not run yet — it happens at the end of this cycle — and reporting the old
    // one would hand the model a POSITIVE drawdown, which is not a thing. Show the peak
    // the lifecycle is about to write.
    const stored = state.peakPriceSinceEntry;
    const peak = stored == null ? price : price == null ? stored : Decimal.max(stored, price);
    positions.push({
      asset,
      entryDate: state.entryDate,
      peakPriceSinceEntry: peak == null ? null : n2(peak),
      drawdownFromPeakPercent:
        peak != null && price != null && peak.gt(0) ? n2(price.minus(peak).div(peak).times(100)) : null,
      lastSignificantMoveAt: state.lastSignificantMoveAt,
      lastSignificantMoveSide: state.lastSignificantMoveSide,
      lastSignificantMoveNotional:
        state.lastSignificantMoveNotional == null ? null : n2(state.lastSignificantMoveNotional),
      thesis: state.thesis,
      invalidation: state.invalidation,
    });
  }
  return { ...base, regime: market.regime, positions };
}

/**
 * Builds a price lookup from the market context: the reserve stable is worth 1,
 * every other asset is priced from the pair whose base it is (tradable first,
 * then reference). Returns null when no live price is available.
 */
export function buildPriceLookup(
  market: MarketContext,
  reserveAsset: string,
): PriceLookup {
  const prices = new Map<string, Decimal>();
  for (const pair of [...market.market.tradable, ...market.market.reference]) {
    const [base, quote] = pair.symbol.split('/');
    // Guard a non-finite OR non-positive price (partial/garbage fetch): never
    // feed null/NaN to Decimal (it throws), and treat 0 or negative as no price
    // (a finite 0 would otherwise value the position at 0 and corrupt P&L). Skip
    // it — the asset just has no live price, which the rest of the code handles
    // via the avgCost fallback (priceStale).
    if (base && quote === reserveAsset && Number.isFinite(pair.price) && pair.price > 0 && !prices.has(base)) {
      prices.set(base, new Decimal(pair.price));
    }
  }
  return (asset: string): Decimal | null => {
    if (asset === reserveAsset) return ONE;
    return prices.get(asset) ?? null;
  };
}
