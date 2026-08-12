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

/**
 * ONE ASSET AS THE MODEL SEES IT UNDER `enforce` — the actionable state, not the candidate.
 *
 * Three deliberate absences, and each closes a measured defect rather than a hypothetical:
 *
 *   - NO `raw`, NO `pendingRegime`, NO `pendingBars`. These describe the candidate label
 *     that has not yet confirmed. Showing them let the model ANTICIPATE a regime change —
 *     that is what happened on XRP — and the fix has to be structural. Writing "do not use
 *     this" beside them would make a deterministic invariant depend on the model obeying a
 *     sentence, which is not an invariant at all. They stay in `decisions.regime`, which
 *     the dashboard reads directly, so nothing is lost for observability.
 *
 *   - NO tactical FLAGS when the asset is not actionable. `pullbackConsumed` and
 *     `bounceConsumed` are computed on the CURRENT bar while the regime label is smoothed
 *     over three confirmation bars. During a transition that pair is exactly the "label
 *     describing the past next to flags describing the present" the report identified, and
 *     the v5 playbook tells the model to treat it as an instruction. Withheld while frozen,
 *     restored the moment the regime confirms.
 *
 *     The other 4h numbers (`rsi14H4`, `ema21H4`, `h4RangePosition`) are kept: they are raw
 *     measurements, not verdicts, and the model needs to see the market it cannot act on.
 *
 *   - `actionable` is PRESENT and explicit, so "may I trade this line" is a field rather
 *     than an inference the model makes from a label.
 */
export interface ActionableAssetView {
  /** risk_off when the global override is confirmed, else the CONFIRMED regime. */
  effective: string;
  /** The confirmed regime after hysteresis — never the candidate. */
  regime: string;
  /** May the model place a strategic order on this line this cycle? */
  actionable: boolean;
  bearish: boolean;
  signals: Record<string, unknown>;
}

export interface ActionableRegimeView {
  version: string;
  barAt: string;
  global: {
    riskOff: boolean;
    breadthPercent: number;
    medianH4Rsi: number | null;
    assetsPresent: number;
    assetsExpected: number;
  };
  assets: Record<string, ActionableAssetView>;
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
   *
   * Under `observe` this is the FULL `RegimeJournal`, byte-identical to what the model has
   * been shown since v5 shipped. Under `enforce` it is the reduced `ActionableRegimeView`.
   * The mode gates it for the same reason it gates the gate: going back to `observe` has to
   * restore what the model reads, not only what the code does, or the rollback would land
   * on a third behaviour nobody has measured.
   */
  regime?: MarketContext['regime'] | ActionableRegimeView;
  positions?: PositionLifecycleView[];
}

/** The two flags withheld while an asset is not actionable — see ActionableAssetView. */
const TACTICAL_FLAGS = ['pullbackConsumed', 'bounceConsumed'] as const;

/**
 * Projects the full regime journal onto what `enforce` shows the model.
 *
 * Exported so the payload can be asserted on its KEYS by a test rather than trusted: the
 * whole point of removing `raw` is that it is not reachable, and "we removed it" is a claim
 * a test should be able to falsify.
 */
export function toActionableRegimeView(
  regime: NonNullable<MarketContext['regime']>,
  actionableByAsset: Map<string, boolean>,
): ActionableRegimeView {
  const assets: ActionableRegimeView['assets'] = {};
  for (const [asset, entry] of Object.entries(regime.assets)) {
    // Default FALSE, not true. An asset the transition layer produced no verdict for is
    // one the code cannot vouch for, and the safe reading of "unknown" here is "do not
    // act" — the mirror of the ladder's own refusal to guess.
    const actionable = actionableByAsset.get(asset) ?? false;
    const signals: Record<string, unknown> = { ...entry.signals };
    if (!actionable) {
      for (const flag of TACTICAL_FLAGS) delete signals[flag];
    }
    assets[asset] = {
      effective: entry.effective,
      regime: entry.regime,
      actionable,
      bearish: entry.bearish,
      signals,
    };
  }
  return {
    version: regime.version,
    barAt: regime.barAt,
    // `raw` and `pendingBars` dropped here too: the global override has the same
    // candidate/confirmed split as the per-asset labels, and the same reason to hide it.
    global: {
      riskOff: regime.global.riskOff,
      breadthPercent: regime.global.breadthPercent,
      medianH4Rsi: regime.global.medianH4Rsi,
      assetsPresent: regime.global.assetsPresent,
      assetsExpected: regime.global.assetsExpected,
    },
    assets,
  };
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
  /**
   * The transition layer's mode, and its per-asset verdict.
   *
   * BOTH default to today's behaviour — `observe`, no verdicts — so every existing caller
   * (the tests, the printers, the replay harness) keeps producing the payload it produced
   * before this PR without being touched. Only `decide()` passes them.
   */
  gate: { mode: 'observe' | 'enforce'; actionableByAsset: Map<string, boolean> } = {
    mode: 'observe',
    actionableByAsset: new Map(),
  },
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
  // THE ONLY PAYLOAD DIFFERENCE BETWEEN THE TWO MODES. In `observe` the journal goes
  // through untouched — byte-identical to every cycle since v5 shipped, which is what makes
  // the switch a true rollback. In `enforce` the model is shown the actionable state.
  const regime =
    gate.mode === 'enforce' && market.regime != null
      ? toActionableRegimeView(market.regime, gate.actionableByAsset)
      : market.regime;
  return { ...base, regime, positions };
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
