import 'dotenv/config';
import { config } from '../config/index.js';
import type { DecisionContext, PositionLifecycleView } from '../decision/context.js';
import { buildSystemPromptV5, buildUserPromptV5 } from '../decision/promptV5.js';
import { assertAnthropicConfigured, runDecision } from '../decision/llm.js';
import { validateDecision, type ValidatedDecision } from '../decision/schema.js';

/**
 * BEHAVIOURAL PROBES for the v5 mandate — the obligatory proof of PR 4.
 *
 * The deterministic replay cannot answer the question that matters. It can prove the
 * regime is computed correctly and that no crumb reaches the exchange; it cannot prove
 * the MODEL will take its profits. Activating v5 with no test of the model would leave
 * us exposed to exactly the failure the whole chantier exists to fix — a mandate that
 * reads well and produces 785 holds.
 *
 * So: eight isolated scenarios on synthetic context, each with a behaviour CLASS it
 * must fall into, and the model's real answers printed in full.
 *
 * Four of them come in PAIRS that share a label and differ only in whether the move
 * has already been paid — P1 against P7 for reversal_down, P2 against P8 for
 * reversal_up. Their checks are paired too: it is not enough for P7 to hold, it must
 * hold MORE than P1 lightened. A mandate that behaves identically across a pair has
 * discriminated nothing, and a probe that would not notice is the same weak criterion
 * as "at least one differing bar".
 *
 * What these probes are NOT: a backtest, or any promise about performance. Eight
 * scenarios prove that the mandate produces the right kind of decision when the
 * situation is unambiguous. That is a necessary condition, not a sufficient one.
 *
 * SAFETY, by construction rather than by care: this file imports the prompt, the LLM
 * client and the validator — and nothing else. No Supabase, no exchange client, no
 * Telegram, no Healthchecks. It cannot write a row or place an order because it has no
 * way to reach either.
 *
 * Run with `npm run probe:v5`.
 */

/** Production runs claude-sonnet-4-6 (verified against `decisions.model`, 789 cycles). */
const PRODUCTION_MODEL = 'claude-sonnet-4-6';

const ASSETS = ['BTC', 'ETH', 'BNB', 'XRP', 'USDT'];
const RESERVE = 'USDT';

interface Holding {
  asset: string;
  price: number;
  avgCost: number;
  weight: number;
  /** Per-asset regime as the code would have computed it. */
  regime: string;
  /** Where price sits in its 30-day range, 0..1 (the STRUCTURAL position). */
  rangePosition: number;
  peak: number;
  thesis?: string;
  /**
   * Where price sits in its recent 4h range, 0..1 — the TACTICAL position. Defaults to
   * the monthly one, which is what the first six probes assumed. P7 and P8 turn on the
   * two DIVERGING: high on the month, low on the 4h (or the reverse) is exactly the
   * case a single shared number could not express.
   */
  h4RangePosition?: number;
  /**
   * The daily structure, stated rather than guessed from the label. It used to be
   * derived from whether the regime name contained "up", which silently made the
   * signals contradict the label: `reversal_up` requires the up-structure NOT to be
   * confirmed, yet the derivation produced a confirmed one. Harmless while the
   * signals were decoration; fatal now that they are the discriminator.
   */
  structure?: 'up' | 'down' | 'unconfirmed';
  /** 4h momentum. Independent of the range position — see `momentumOf`. */
  momentum?: 'up' | 'down' | 'neutral';
}

/**
 * The DAILY structure a label implies, unless the probe overrides it.
 *
 * Defaulted from the label rather than from whether its name contains "up", which is
 * what the first version did and which quietly produced contexts contradicting their
 * own label: `reversal_down` means momentum turning against a structure that has NOT
 * broken, so its structure is UP, not down.
 */
function structureOf(h: Holding): 'up' | 'down' | 'unconfirmed' {
  if (h.structure) return h.structure;
  if (h.regime === 'trend_up') return 'up';
  if (h.regime === 'trend_down') return 'down';
  if (h.regime === 'reversal_down') return 'up'; // momentum down against an intact trend
  return 'unconfirmed'; // reversal_up: the up-structure is by definition not confirmed
}

/**
 * 4h momentum, defaulted from the label and NOT derived from the range position.
 *
 * Conflating the two is what broke these contexts: momentum and "where price sits" are
 * two separate axes in the real classifier, and a reversal_down high in its range has
 * a LOW 4h RSI — that combination is the whole signal. Deriving the RSI from the range
 * position made it high instead, handing the model a reversal_down that looked bullish.
 */
function momentumOf(h: Holding): 'up' | 'down' | 'neutral' {
  if (h.momentum) return h.momentum;
  if (h.regime.endsWith('_down')) return 'down';
  if (h.regime.endsWith('_up')) return 'up';
  return 'neutral';
}

function averagesFor(h: Holding): { sma50: number; ema21Daily: number; sma200: number } {
  const structure = structureOf(h);
  if (structure === 'up') return { sma50: h.price * 0.95, ema21Daily: h.price * 0.98, sma200: h.price * 1.15 };
  if (structure === 'down') return { sma50: h.price * 1.05, ema21Daily: h.price * 1.02, sma200: h.price * 1.15 };
  return { sma50: h.price * 0.97, ema21Daily: h.price * 0.96, sma200: h.price * 1.15 };
}

function h4For(h: Holding): { ema21H4: number; rsi14H4: number } {
  const m = momentumOf(h);
  if (m === 'up') return { ema21H4: h.price * 0.99, rsi14H4: 63 };
  if (m === 'down') return { ema21H4: h.price * 1.01, rsi14H4: 37 };
  return { ema21H4: h.price, rsi14H4: 50 };
}

const tacticalOf = (h: Holding): number => h.h4RangePosition ?? h.rangePosition;

/** Builds a plausible synthetic context: market read, code regime, book, lifecycle. */
function buildContext(params: {
  holdings: Holding[];
  cashWeight: number;
  riskOff?: boolean;
  equity?: number;
}): DecisionContext {
  const { holdings, cashWeight, riskOff = false, equity = 1000 } = params;

  const tradable = holdings.map((h) => ({
    symbol: `${h.asset}/USDT`,
    kind: 'tradable' as const,
    price: h.price,
    primary: { timeframe: '1d', candles: 500 },
    indicators: {
      rsi: { period: 14, value: 30 + h.rangePosition * 40 },
      sma: { 50: averagesFor(h).sma50, 200: averagesFor(h).sma200 },
      ema: { 21: averagesFor(h).ema21Daily },
    },
    levels: {
      month: {
        high: { price: h.peak, at: '2026-07-16T00:00:00.000Z' },
        low: { price: h.peak * 0.75, at: '2026-06-26T00:00:00.000Z' },
      },
      year: {
        high: { price: h.peak * 1.9, at: '2025-10-06T00:00:00.000Z' },
        low: { price: h.peak * 0.7, at: '2026-07-01T00:00:00.000Z' },
      },
      allTime: null,
    },
  }));

  const positions = holdings
    .filter((h) => h.weight > 0)
    .map((h) => ({
      asset: h.asset,
      qty: Number(((equity * h.weight) / 100 / h.price).toFixed(8)),
      avgCost: h.avgCost,
      price: h.price,
      priceStale: false,
      value: Number(((equity * h.weight) / 100).toFixed(2)),
      unrealizedPnl: Number((((equity * h.weight) / 100) * (1 - h.avgCost / h.price)).toFixed(2)),
      weightPercent: h.weight,
    }));

  const lifecycle: PositionLifecycleView[] = holdings
    .filter((h) => h.weight > 0)
    .map((h) => ({
      asset: h.asset,
      entryDate: '2026-06-08T10:30:00.000Z',
      peakPriceSinceEntry: h.peak,
      drawdownFromPeakPercent: Number((((h.price - h.peak) / h.peak) * 100).toFixed(2)),
      lastSignificantMoveAt: '2026-06-08T10:30:00.000Z',
      lastSignificantMoveSide: 'buy',
      lastSignificantMoveNotional: Number(((equity * h.weight) / 100).toFixed(2)),
      thesis: h.thesis ?? null,
      invalidation: h.thesis ? 'a daily close back under the 50d' : null,
    }));

  const regimeAssets = Object.fromEntries(
    holdings.map((h) => [
      h.asset,
      {
        effective: riskOff ? 'risk_off' : h.regime,
        regime: h.regime,
        raw: h.regime,
        pendingRegime: null,
        pendingBars: 0,
        bearish: h.regime.includes('down'),
        signals: {
          close: h.price,
          ...averagesFor(h),
          rsi14Daily: 30 + h.rangePosition * 40,
          rangeHigh: h.peak,
          rangeLow: h.peak * 0.75,
          rangePosition: h.rangePosition,
          ...h4For(h),
          h4RangeHigh: h.peak,
          h4RangeLow: h.peak * 0.8,
          h4RangePosition: tacticalOf(h),
          pullbackConsumed: tacticalOf(h) <= config.regime.thresholds.pullbackConsumedPosition,
          bounceConsumed: tacticalOf(h) >= config.regime.thresholds.bounceConsumedPosition,
        },
      },
    ]),
  );

  const deployed = holdings.reduce((n, h) => n + h.weight, 0);
  return {
    generatedAt: '2026-07-25T12:00:00.000Z',
    source: { marketData: 'binance-public-mainnet', account: 'binance-testnet' },
    market: { tradable: tradable as never, reference: [] },
    account: {
      portfolio: {
        reserveAsset: RESERVE,
        startingCapital: 1000,
        cash: Number(((equity * cashWeight) / 100).toFixed(2)),
        equity,
        deployedPercent: deployed,
        realizedPnl: 0,
        unrealizedPnl: positions.reduce((n, p) => n + p.unrealizedPnl, 0),
        totalPnl: equity - 1000,
        positions,
      },
    },
    regime: {
      version: 'r1',
      barAt: '2026-07-25T08:00:00.000Z',
      global: {
        riskOff,
        raw: riskOff,
        breadthPercent: riskOff ? 100 : 20,
        medianH4Rsi: riskOff ? 25 : 50,
        assetsPresent: holdings.length,
        assetsExpected: holdings.length,
        pendingBars: 0,
      },
      assets: regimeAssets,
    } as never,
    positions: lifecycle,
  };
}

/** Allocation change per asset from a probe already run — for the paired assertions. */
const observed = new Map<string, Record<string, number>>();

interface Probe {
  id: string;
  scenario: string;
  expected: string;
  context: DecisionContext;
  /** The behaviour CLASS the answer must fall into. Returns null when it does. */
  check: (d: ValidatedDecision, current: Record<string, number>) => string | null;
}

/** Change in allocation points for an asset, proposed minus current. */
const delta = (d: ValidatedDecision, current: Record<string, number>, asset: string): number =>
  (d.targetAllocation[asset] ?? 0) - (current[asset] ?? 0);

const PROBES: Probe[] = [
  {
    id: 'P1',
    scenario: 'Top of range, position well in profit, ETH in reversal_down',
    expected: 'a SIGNIFICANT lightening of ETH (at least 25% of the line)',
    context: buildContext({
      cashWeight: 32,
      holdings: [
        { asset: 'BTC', price: 64000, avgCost: 63000, weight: 25, regime: 'range', rangePosition: 0.5, peak: 67000 },
        { asset: 'ETH', price: 1940, avgCost: 1550, weight: 28, regime: 'reversal_down', rangePosition: 0.95, h4RangePosition: 0.62, peak: 1948, thesis: 'riding the reclaim off the June low' },
        { asset: 'BNB', price: 565, avgCost: 595, weight: 10, regime: 'range', rangePosition: 0.5, peak: 630 },
        { asset: 'XRP', price: 1.08, avgCost: 1.14, weight: 5, regime: 'range', rangePosition: 0.45, peak: 1.28 },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'ETH');
      const relative = -change / (cur.ETH ?? 1);
      if (change >= 0) return `ETH was not reduced at all (${change.toFixed(1)} pts)`;
      if (relative < 0.25) return `ETH was trimmed by only ${(relative * 100).toFixed(0)}% of the line (< 25%)`;
      return null;
    },
  },
  {
    id: 'P2',
    scenario: 'Bottom of range, BTC in reversal_up, plenty of cash',
    expected: 'ACCUMULATION on BTC (a real increase, not a token one)',
    context: buildContext({
      cashWeight: 62,
      holdings: [
        { asset: 'BTC', price: 58500, avgCost: 63000, weight: 12, regime: 'reversal_up', rangePosition: 0.2, peak: 67000, thesis: 'waiting for a base' },
        { asset: 'ETH', price: 1700, avgCost: 1660, weight: 14, regime: 'range', rangePosition: 0.4, peak: 1948 },
        { asset: 'BNB', price: 560, avgCost: 595, weight: 7, regime: 'range', rangePosition: 0.4, peak: 630 },
        { asset: 'XRP', price: 1.05, avgCost: 1.14, weight: 5, regime: 'range', rangePosition: 0.35, peak: 1.28 },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'BTC');
      if (change < 2) return `BTC was increased by only ${change.toFixed(1)} pts (below the 2% floor)`;
      return null;
    },
  },
  {
    id: 'P3',
    scenario: 'BTC trend_up intact, a shallow pullback from the peak',
    expected: 'HOLD or ADD — no mechanical selling into an intact trend',
    context: buildContext({
      cashWeight: 33,
      holdings: [
        { asset: 'BTC', price: 65000, avgCost: 58000, weight: 30, regime: 'trend_up', rangePosition: 0.82, h4RangePosition: 0.55, peak: 67000, thesis: 'trend intact above the reclaimed 50d' },
        { asset: 'ETH', price: 1860, avgCost: 1660, weight: 20, regime: 'range', rangePosition: 0.6, peak: 1948 },
        { asset: 'BNB', price: 570, avgCost: 595, weight: 10, regime: 'range', rangePosition: 0.5, peak: 630 },
        { asset: 'XRP', price: 1.09, avgCost: 1.14, weight: 7, regime: 'range', rangePosition: 0.5, peak: 1.28 },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'BTC');
      if (change < -2) return `BTC was cut by ${Math.abs(change).toFixed(1)} pts into an intact uptrend`;
      return null;
    },
  },
  {
    id: 'P4',
    scenario: 'XRP in trend_down, far below its peak since entry',
    expected: 'REDUCTION or full EXIT of XRP',
    context: buildContext({
      cashWeight: 35,
      holdings: [
        { asset: 'BTC', price: 64000, avgCost: 63000, weight: 25, regime: 'range', rangePosition: 0.5, peak: 67000 },
        { asset: 'ETH', price: 1850, avgCost: 1660, weight: 20, regime: 'range', rangePosition: 0.55, peak: 1948 },
        { asset: 'BNB', price: 570, avgCost: 595, weight: 8, regime: 'range', rangePosition: 0.5, peak: 630 },
        { asset: 'XRP', price: 0.95, avgCost: 1.14, weight: 12, regime: 'trend_down', rangePosition: 0.08, peak: 1.2856, thesis: 'payments narrative, accumulating the low' },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'XRP');
      const relative = -change / (cur.XRP ?? 1);
      if (change >= 0) return `XRP was not reduced (${change.toFixed(1)} pts) despite trend_down`;
      if (relative < 0.25) return `XRP was cut by only ${(relative * 100).toFixed(0)}% of the line (< 25%)`;
      return null;
    },
  },
  {
    id: 'P5',
    scenario: 'Global risk_off override active over the whole universe',
    expected: 'a GLOBAL reduction of exposure — cash up materially',
    context: buildContext({
      cashWeight: 32,
      riskOff: true,
      holdings: [
        { asset: 'BTC', price: 57000, avgCost: 63000, weight: 25, regime: 'trend_down', rangePosition: 0.1, peak: 67000, thesis: 'core holding' },
        { asset: 'ETH', price: 1520, avgCost: 1660, weight: 22, regime: 'trend_down', rangePosition: 0.08, peak: 1948, thesis: 'core holding' },
        { asset: 'BNB', price: 505, avgCost: 595, weight: 12, regime: 'trend_down', rangePosition: 0.05, peak: 630 },
        { asset: 'XRP', price: 0.92, avgCost: 1.14, weight: 9, regime: 'trend_down', rangePosition: 0.06, peak: 1.2856 },
      ],
    }),
    check: (d, cur) => {
      const cashChange = delta(d, cur, RESERVE);
      if (cashChange < 5) return `cash rose by only ${cashChange.toFixed(1)} pts under a risk_off override`;
      return null;
    },
  },
  {
    id: 'P6',
    scenario: 'Everything in range, nothing material changed, theses already written',
    expected: 'HOLD, and NO rewriting of the existing theses',
    context: buildContext({
      cashWeight: 33,
      holdings: [
        { asset: 'BTC', price: 64000, avgCost: 63000, weight: 25, regime: 'range', rangePosition: 0.5, peak: 67000, thesis: 'core holding, waiting for the range to resolve' },
        { asset: 'ETH', price: 1860, avgCost: 1660, weight: 22, regime: 'range', rangePosition: 0.52, peak: 1948, thesis: 'holding the reclaim, no reason to touch it' },
        { asset: 'BNB', price: 570, avgCost: 595, weight: 12, regime: 'range', rangePosition: 0.48, peak: 630, thesis: 'underwater but structurally intact' },
        { asset: 'XRP', price: 1.09, avgCost: 1.14, weight: 8, regime: 'range', rangePosition: 0.5, peak: 1.2856, thesis: 'smallest line, leaving it alone' },
      ],
    }),
    check: (d, cur) => {
      const biggest = Math.max(...ASSETS.map((a) => Math.abs(delta(d, cur, a))));
      if (biggest >= 2) return `allocation moved by ${biggest.toFixed(1)} pts with nothing to act on`;
      if (d.positionNotes.length > 0) {
        return `rewrote ${d.positionNotes.length} thesis/theses (${d.positionNotes.map((n) => n.asset).join(', ')}) on a hold`;
      }
      return null;
    },
  },
  {
    id: 'P7',
    scenario: 'ETH in reversal_down but the pullback is ALREADY CONSUMED — low on the 4h, daily structure intact',
    expected: 'NO material reduction — this is a dip inside an intact trend, not a top',
    context: buildContext({
      cashWeight: 33,
      holdings: [
        // The live shape of BTC/ETH on 2026-07-25: high on the month, bottom of the 4h
        // range, both price and the daily EMA21 still above the SMA50.
        { asset: 'ETH', price: 1857, avgCost: 1660, weight: 28, regime: 'reversal_down', rangePosition: 0.78, h4RangePosition: 0.17, structure: 'up', peak: 1948, thesis: 'holding the reclaim off the June low' },
        { asset: 'BTC', price: 64064, avgCost: 63000, weight: 22, regime: 'reversal_down', rangePosition: 0.68, h4RangePosition: 0.25, structure: 'up', peak: 67234, thesis: 'core holding above the reclaimed 50d' },
        { asset: 'BNB', price: 565, avgCost: 595, weight: 10, regime: 'range', rangePosition: 0.5, peak: 630 },
        { asset: 'XRP', price: 1.09, avgCost: 1.14, weight: 7, regime: 'range', rangePosition: 0.46, peak: 1.2856 },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'ETH');
      if (change < -1) return `ETH was cut by ${Math.abs(change).toFixed(1)} pts into an already-consumed pullback`;
      // PAIRED against P1: the same label, the opposite situation. A mandate that
      // lightens identically in both has discriminated nothing — which is exactly the
      // weak-criterion trap ("at least one differing bar") caught on C2.
      const p1 = observed.get('P1')?.ETH;
      if (p1 != null && change <= p1) {
        return `ETH was cut as hard as in P1 (${change.toFixed(1)} vs ${p1.toFixed(1)} pts) — the two cases were not told apart`;
      }
      return null;
    },
  },
  {
    id: 'P8',
    scenario: 'BTC in reversal_up but the bounce is ALREADY CONSUMED — top of the 4h range, month already stretched',
    expected: 'NO material increase — chasing here is buying the top',
    context: buildContext({
      cashWeight: 55,
      holdings: [
        // The mirror of P7: momentum up, up-structure NOT confirmed (that is what makes
        // it reversal_up), but the move has already been paid and the month is extended.
        { asset: 'BTC', price: 66800, avgCost: 63000, weight: 15, regime: 'reversal_up', rangePosition: 0.93, h4RangePosition: 0.88, structure: 'unconfirmed', peak: 67234, thesis: 'bought the reclaim, watching the monthly high' },
        { asset: 'ETH', price: 1780, avgCost: 1660, weight: 16, regime: 'range', rangePosition: 0.55, peak: 1948 },
        { asset: 'BNB', price: 565, avgCost: 595, weight: 8, regime: 'range', rangePosition: 0.5, peak: 630 },
        { asset: 'XRP', price: 1.09, avgCost: 1.14, weight: 6, regime: 'range', rangePosition: 0.46, peak: 1.2856 },
      ],
    }),
    check: (d, cur) => {
      const change = delta(d, cur, 'BTC');
      if (change > 1) return `BTC was increased by ${change.toFixed(1)} pts into an already-consumed bounce`;
      const p2 = observed.get('P2')?.BTC;
      if (p2 != null && change >= p2) {
        return `BTC was added to as hard as in P2 (${change.toFixed(1)} vs +${p2.toFixed(1)} pts) — the two cases were not told apart`;
      }
      return null;
    },
  },
];

function currentAllocation(ctx: DecisionContext): Record<string, number> {
  const p = ctx.account.portfolio;
  const current: Record<string, number> = { [RESERVE]: Number(((p.cash / p.equity) * 100).toFixed(2)) };
  for (const pos of p.positions) current[pos.asset] = pos.weightPercent;
  return current;
}

async function main(): Promise<number> {
  assertAnthropicConfigured();
  // Pin the PRODUCTION model. The local default is Haiku (cheap plumbing checks);
  // probing the mandate on a model production does not run would prove nothing about
  // production. Verified against `decisions.model`: 789 cycles on claude-sonnet-4-6.
  process.env.ANTHROPIC_MODEL = process.env.PROBE_MODEL?.trim() || PRODUCTION_MODEL;

  console.log('='.repeat(100));
  console.log('v5 BEHAVIOURAL PROBES');
  console.log(`model: ${process.env.ANTHROPIC_MODEL}  ·  synthetic context  ·  NO persistence, NO exchange, NO alerting`);
  console.log(
    `size norm in force: at least ${config.execution.minMovementPercent}% of capital AND at least 25% of the position`,
  );
  console.log('='.repeat(100));

  const systemPrompt = buildSystemPromptV5();
  let failures = 0;

  for (const probe of PROBES) {
    const current = currentAllocation(probe.context);
    const userPrompt = buildUserPromptV5({
      allocationAssets: ASSETS,
      reserveStable: RESERVE,
      context: probe.context,
      lastSignificant: null,
    });

    const llm = await runDecision({ systemPrompt, userPrompt, assets: ASSETS, strategy: 'v5' });
    console.log('');
    console.log('─'.repeat(100));
    console.log(`${probe.id} — ${probe.scenario}`);
    console.log(`     expected: ${probe.expected}`);

    if (!llm.parsed) {
      failures += 1;
      console.log(`     VERDICT: FAIL — the model produced no usable output (${llm.parseError ?? 'unknown'})`);
      continue;
    }
    const validation = validateDecision(llm.parsed, ASSETS, config, 'v5');
    if (!validation.ok) {
      failures += 1;
      console.log(`     VERDICT: FAIL — invalid decision (${validation.error})`);
      continue;
    }

    const d = validation.value;
    const moves = ASSETS.map((a) => {
      const change = delta(d, current, a);
      return `${a} ${(current[a] ?? 0).toFixed(1)}→${(d.targetAllocation[a] ?? 0).toFixed(1)} (${change >= 0 ? '+' : ''}${change.toFixed(1)})`;
    }).join('  ');

    console.log(`     action:   ${d.actionType}  ·  confidence ${d.confidence}`);
    console.log(`     moves:    ${moves}`);
    console.log(`     theses:   ${d.positionNotes.length === 0 ? '(none rewritten)' : d.positionNotes.map((n) => `${n.asset}${n.replace ? ' [replace]' : ''}: ${n.thesis}`).join(' | ')}`);
    console.log(`     model:    ${d.reasoning.replace(/\s+/g, ' ').slice(0, 400)}`);
    console.log(`     notif:    ${d.notificationSummary}`);

    // Record every delta so the paired probes (P7 vs P1, P8 vs P2) can compare.
    observed.set(probe.id, Object.fromEntries(ASSETS.map((a) => [a, delta(d, current, a)])));

    const problem = probe.check(d, current);
    if (problem) {
      failures += 1;
      console.log(`     VERDICT: FAIL — ${problem}`);
    } else {
      console.log('     VERDICT: PASS');
    }
  }

  console.log('');
  console.log('='.repeat(100));
  console.log(
    `${PROBES.length - failures}/${PROBES.length} probes in the expected behaviour class` +
      (failures === 0 ? ' — the v5 mandate produces the right kind of decision.' : ''),
  );
  console.log(
    'These probes are neither a backtest nor a promise of performance: they show the mandate',
  );
  console.log('behaves correctly when the situation is unambiguous. Necessary, not sufficient.');
  console.log('='.repeat(100));
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('v5 probes failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
