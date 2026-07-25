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
 * So: six isolated scenarios on synthetic context, each with a behaviour CLASS it must
 * fall into, and the model's real answers printed in full.
 *
 * What these probes are NOT: a backtest, or any promise about performance. Six
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
  /** Where price sits in its 30-day range, 0..1. */
  rangePosition: number;
  peak: number;
  thesis?: string;
}

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
      sma: { 50: h.price * (h.regime.includes('up') ? 0.95 : 1.05), 200: h.price * 1.15 },
      ema: { 21: h.price * (h.regime.includes('up') ? 0.98 : 1.02) },
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
          sma50: h.price * (h.regime.includes('up') ? 0.95 : 1.05),
          sma200: h.price * 1.15,
          ema21Daily: h.price * (h.regime.includes('up') ? 0.98 : 1.02),
          rsi14Daily: 30 + h.rangePosition * 40,
          rangeHigh: h.peak,
          rangeLow: h.peak * 0.75,
          rangePosition: h.rangePosition,
          ema21H4: h.price * 0.99,
          rsi14H4: 30 + h.rangePosition * 40,
          h4RangeHigh: h.peak,
          h4RangeLow: h.peak * 0.8,
          h4RangePosition: h.rangePosition,
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
        { asset: 'ETH', price: 1940, avgCost: 1550, weight: 28, regime: 'reversal_down', rangePosition: 0.95, peak: 1948, thesis: 'riding the reclaim off the June low' },
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
        { asset: 'BTC', price: 65000, avgCost: 58000, weight: 30, regime: 'trend_up', rangePosition: 0.82, peak: 67000, thesis: 'trend intact above the reclaimed 50d' },
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
