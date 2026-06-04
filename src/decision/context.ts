import { Decimal, ONE } from '../money.js';
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
export interface DecisionContext {
  generatedAt: string;
  source: MarketContext['source'];
  market: MarketContext['market'];
  account: { portfolio: PortfolioView };
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
): DecisionContext {
  return {
    generatedAt: market.generatedAt,
    source: market.source,
    market: market.market,
    account: { portfolio: toPortfolioView(portfolio) },
  };
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
    // Guard a non-finite price (partial fetch): never feed null/NaN to Decimal
    // (it throws and would kill the whole cycle). Skip it — the asset just has
    // no live price, which the portfolio/movements code already handles.
    if (base && quote === reserveAsset && Number.isFinite(pair.price) && !prices.has(base)) {
      prices.set(base, new Decimal(pair.price));
    }
  }
  return (asset: string): Decimal | null => {
    if (asset === reserveAsset) return ONE;
    return prices.get(asset) ?? null;
  };
}
