import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDailyTable } from '../bench/exit/daily.js';
import { makeExitRule, stepTrailingLine, type TrailingLine } from '../bench/exit/rules.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import { runWindow, type HoldingView } from '../bench/exposure/engine.js';
import { executeAllocation } from '../bench/exposure/execute.js';
import { T100 } from '../bench/exposure/policy.js';
import { prepareExitDevelopmentTape } from '../bench/exposure/tape.js';
import { EXIT_DEVELOPMENT } from '../bench/exposure/windows.js';
import { computeMovements } from '../execution/movements.js';
import type { Candle } from '../market/klines.js';
import type { StickyPoint } from '../market/transition.js';
import { Decimal, ZERO } from '../money.js';
import { derivePortfolio } from '../portfolio/derive.js';
import {
  applyDailyCloses,
  dueCloses,
  missingClose,
  nextCycleDelayMinutes,
  plannerAllocation,
  readDailyTable,
  reconcileEntries,
  s4Allocation,
  s4Gate,
  type S4Line,
} from '../s4/core.js';
import { explainS4 } from '../s4/explain.js';
import { fallbackExplanation, formatS4Activity, prepareS4Notification } from '../alerting/s4Activity.js';
import type { S4Report } from '../s4/cycle.js';
import { seedLinesOf, type Reconstruction } from '../s4/reconstruct.js';

/**
 * S4 IN PRODUCTION — the proofs the brief of 06/11/2026 asks for:
 *
 *   1. equivalence: production's core, driven bar by bar over the bench's own candles, gives the
 *      bench's S4 run EXACTLY (every bar's out-set, line states, weights and equity);
 *   2. the transition gate: an exit passes a freeze, a rebuy waits for it;
 *   3. a full exit leaves no residue and nothing recreates the line;
 *   4. a model failure has no effect on the orders;
 *   5. a missing or incomplete daily candle blocks the decision without consuming it;
 *   6. a restart never decides the same close twice;
 *   7. the reconstructed start: the seed is the bench's state, and topping a line up keeps its high.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}
const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const ASSETS = ['BNB', 'BTC', 'ETH', 'XRP'];
const cfg = buildBenchConfig();

// ── PROOF 1 — PRODUCTION CORE = BENCH S4, ON THE SAME CANDLES ──────────────────────────────
console.log('Proof 1 — production S4 against the bench, bar for bar, development window:');
{
  const tape = prepareExitDevelopmentTape(process.cwd());
  const table = buildDailyTable(tape, cfg.basket);
  const window = EXIT_DEVELOPMENT;
  const bench = runWindow({ tape, cfg, policy: T100, window, exitRule: makeExitRule('S4', table) });

  // The production loop: the same instants, the same fills (the bench's executor stands in for
  // the exchange), but every DECISION made by production's own functions.
  let cash = new Decimal(cfg.startingCashUsd);
  const qty: Record<string, Decimal> = {};
  let lines: S4Line[] = ASSETS.map((asset) => ({ asset, status: 'in', entryAtMs: null, high: null, exitAtMs: null, armed: false, entryPrice: null, lastMoveReason: null, lastMoveAtMs: null }));
  let pending: Record<string, number> | null = null;
  let lastClose: number | null = null;
  const points = tape.points.filter((p) => p.timestamp >= window.fromMs && p.timestamp < window.toMs);
  let firstDivergence: string | null = null;
  for (let k = 0; k < points.length && firstDivergence == null; k += 1) {
    const t = points[k]!.timestamp;
    const bar = (a: string) => tape.tapes[a]!.h4[tape.tapes[a]!.indexByTs.get(t)!]!;
    const opens = Object.fromEntries(ASSETS.map((a) => [a, new Decimal(bar(a).open)]));
    const closes = Object.fromEntries(ASSETS.map((a) => [a, new Decimal(bar(a).close)]));
    if (pending) {
      const before = Object.fromEntries(ASSETS.map((a) => [a, (qty[a] ?? ZERO).gt(0)]));
      const equityOpen = ASSETS.reduce((s, a) => s.plus((qty[a] ?? ZERO).times(opens[a]!)), cash);
      // `plannerAllocation` already resolved the holds at the decision; the bench re-values a
      // hold at the execution open, which is what the production cycle does by deciding and
      // executing at the same instant. Re-valued here exactly as the bench does it.
      const targets: Record<string, number> = {};
      for (const a of ASSETS) {
        const p = pending[a];
        targets[a] = p == null ? ((qty[a] ?? ZERO).times(opens[a]!).div(equityOpen).times(100).toNumber()) : p;
      }
      const book = Object.fromEntries(ASSETS.filter((a) => qty[a]).map((a) => [a, { qty: qty[a]! }]));
      const res = executeAllocation({ cash, book, prices: opens, targets, reserveAsset: cfg.reserveAsset, feePercent: cfg.feePercentPerLeg, slippagePercent: cfg.slippagePercentPerLeg, minMovementPercent: cfg.minMovementPercent });
      cash = res.cash;
      for (const [a, l] of Object.entries(book)) qty[a] = l.qty;
      const after = Object.fromEntries(ASSETS.map((a) => [a, (qty[a] ?? ZERO).gt(0)]));
      const opened = Object.fromEntries(ASSETS.filter((a) => !before[a] && after[a]).map((a) => [a, opens[a]!.toNumber()]));
      lines = reconcileEntries({ lines, held: after, opened, atMs: t }).lines;
      pending = null;
    }
    const deployed = ASSETS.reduce((s, a) => s.plus((qty[a] ?? ZERO).times(closes[a]!)), ZERO);
    const equity = cash.plus(deployed);
    const weights = Object.fromEntries(ASSETS.map((a) => [a, equity.gt(0) ? (qty[a] ?? ZERO).times(closes[a]!).div(equity).times(100).toNumber() : 0]));

    const closeMs = Math.floor((t + tape.barMs) / DAY) * DAY;
    if (closeMs !== lastClose) {
      const closesDue = lastClose == null ? [closeMs] : dueCloses(lastClose, closeMs);
      lastClose = closeMs;
      const holdings: Record<string, HoldingView> = Object.fromEntries(lines.map((l) => [l.asset, { held: (qty[l.asset] ?? ZERO).gt(0), entryAtMs: l.entryAtMs }]));
      lines = applyDailyCloses({ lines, table, closes: closesDue, holdings }).lines;
    }
    const gates = Object.fromEntries(ASSETS.map((a) => [a, s4Gate({ asset: a, sticky: tape.tapes[a]!.stickyByTs.get(t) ?? null, qty: qty[a] ?? ZERO, price: closes[a]!, priceStale: false, stopThresholdPercent: 10 })]));
    const out = new Set(lines.filter((l) => l.status === 'out').map((l) => l.asset));
    const { lines: plan } = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out, gates, weights, priced: Object.fromEntries(ASSETS.map((a) => [a, true])) });
    const wants = plan.some((l) => !l.hold && Math.abs(l.targetPercent - (weights[l.asset] ?? 0)) > 1e-9);
    if (wants) pending = Object.fromEntries(plan.filter((l) => !l.hold).map((l) => [l.asset, l.targetPercent]));
    else pending = null;

    const b = bench.bars[k]!;
    const here = JSON.stringify({ equity: equity.toNumber(), weights, out: ASSETS.filter((a) => out.has(a)), states: Object.fromEntries(plan.map((l) => [l.asset, l.state])) });
    const there = JSON.stringify({ equity: b.equity, weights: b.weights, out: b.ruleOut, states: b.states });
    if (here !== there) firstDivergence = `${new Date(t).toISOString()}: production ${here} / bench ${there}`;
  }
  ok(`every one of the ${bench.bars.length} bars is identical (equity, weights, out-set, line states)${firstDivergence ? ` — ${firstDivergence}` : ''}`, firstDivergence == null);
  ok('the run actually exercised S4: exits and rebuys happened', bench.bars.some((b) => b.ruleExitsDecided.length > 0) && bench.bars.some((b) => b.ruleEntriesDecided.length > 0));
  ok('and the production loop ends on the bench\'s final equity', Math.abs(bench.bars.at(-1)!.equity - bench.finalState.cash.toNumber() - Object.entries(bench.finalState.positions).reduce((s, [a, p]) => s + p.qty.toNumber() * tape.tapes[a]!.h4[tape.tapes[a]!.indexByTs.get(bench.bars.at(-1)!.t)!]!.close, 0)) < 1e-6);
}

// ── PROOF 2 — THE TRANSITION GATE ──────────────────────────────────────────────────────────
console.log('Proof 2 — the transition gate: an S4 exit passes a freeze, a rebuy waits for it:');
{
  const frozen: StickyPoint = { timestamp: 0, raw: 'range', active: 'trend_up', actionable: false, frozen: true, runLength: 1, labelRun: 1, pendingBars: 1 } as unknown as StickyPoint;
  const gate = s4Gate({ asset: 'ETH', sticky: frozen, qty: new Decimal(1), price: new Decimal(100), priceStale: false, stopThresholdPercent: 10 });
  ok('a frozen line reads `frozen` (and never `risk_off_reduction`: the gate is blind to the risk_off)', gate === 'frozen');
  const weights = { BNB: 20, BTC: 32, ETH: 32, XRP: 0 };
  const priced = { BNB: true, BTC: true, ETH: true, XRP: true };
  const gates = { BNB: 'actionable', BTC: 'actionable', ETH: 'frozen', XRP: 'frozen' } as const;
  const exit = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out: new Set(['ETH']), gates: { ...gates, XRP: 'actionable' }, weights, priced }).lines;
  const eth = exit.find((l) => l.asset === 'ETH')!;
  ok('S4 holds ETH out while ETH is frozen: the line is excluded, target 0, not held', eth.state === 'excluded' && eth.targetPercent === 0 && !eth.hold);
  ok('its share stays in cash: the others keep their nominal 32.5 / 20 / 15, 67.5 % invested', exit.find((l) => l.asset === 'BTC')!.targetPercent === 32.5 && exit.find((l) => l.asset === 'BNB')!.targetPercent === 20 && exit.find((l) => l.asset === 'XRP')!.targetPercent === 15);
  const rebuy = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out: new Set(), gates, weights, priced }).lines;
  const xrp = rebuy.find((l) => l.asset === 'XRP')!;
  ok('S4 lets XRP back in while XRP is frozen: the line is held at its current 0 — no rebuy during the freeze', xrp.state === 'fixed' && xrp.hold && xrp.currentPercent === 0);
  const freed = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out: new Set(), gates: { ...gates, XRP: 'actionable' }, weights, priced }).lines;
  ok('the freeze lifted, the rebuy goes to the 15 % target', freed.find((l) => l.asset === 'XRP')!.targetPercent === 15);
  const stop: StickyPoint = { ...(frozen as object), frozen: true } as StickyPoint;
  ok('the 10 % peak stop never fires: a stop verdict reads frozen', s4Gate({ asset: 'BTC', sticky: stop, qty: new Decimal(1), price: new Decimal(1), priceStale: false, stopThresholdPercent: 10 }) === 'frozen');
}

// ── PROOF 3 — A FULL EXIT, AND NOTHING RECREATES IT ─────────────────────────────────────────
console.log('Proof 3 — an S4 exit sells everything and nothing buys it back (A1):');
{
  const ledger = [
    { symbol: 'XRP/USDT', side: 'buy' as const, valuationPrice: new Decimal('1.2'), baseDelta: new Decimal('43.2'), quoteDelta: new Decimal('-51.84') },
    { symbol: 'BTC/USDT', side: 'buy' as const, valuationPrice: new Decimal('76000'), baseDelta: new Decimal('0.0044'), quoteDelta: new Decimal('-334.4') },
  ];
  const prices: Record<string, Decimal> = { XRP: new Decimal('1.2'), BTC: new Decimal('76000'), ETH: new Decimal('2200'), BNB: new Decimal('690'), USDT: new Decimal(1) };
  const priceOf = (a: string) => prices[a] ?? null;
  const book = derivePortfolio(ledger, { startingCapital: new Decimal(1000), reserveAsset: 'USDT', priceOf });
  const weights = Object.fromEntries(ASSETS.map((a) => {
    const p = book.positions.find((x) => x.asset === a);
    return [a, p ? p.value.div(book.equity).times(100).toNumber() : 0];
  }));
  const gates = { BNB: 'actionable', BTC: 'actionable', ETH: 'actionable', XRP: 'actionable' } as const;
  const priced = { BNB: true, BTC: true, ETH: true, XRP: true };
  const plan = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out: new Set(['XRP']), gates, weights, priced }).lines;
  const movements = computeMovements(book, plannerAllocation(plan, 'USDT'), priceOf, 0.1, cfg.minMovementPercent);
  const xrp = movements.find((m) => m.asset === 'XRP');
  ok('the XRP leg is a FULL exit of the held quantity, whatever the plumbing floor', xrp != null && xrp.side === 'sell' && xrp.fullExit === true && xrp.qty.eq(new Decimal('43.2')));
  const after = derivePortfolio([...ledger, { symbol: 'XRP/USDT', side: 'sell', valuationPrice: new Decimal('1.2'), baseDelta: new Decimal('-43.2'), quoteDelta: new Decimal('51.79') }], { startingCapital: new Decimal(1000), reserveAsset: 'USDT', priceOf });
  ok('after the fill no XRP residue remains in the book', !after.positions.some((p) => p.asset === 'XRP'));
  const next = s4Allocation({ assets: ASSETS, basket: cfg.basket, caps: cfg.caps, out: new Set(['XRP']), gates, weights: { ...weights, XRP: 0 }, priced }).lines;
  const again = computeMovements(after, plannerAllocation(next, 'USDT'), priceOf, 0.1, cfg.minMovementPercent);
  ok('the next cycle buys no XRP back while S4 holds it out — no band, floor or correction exists to recreate it', !again.some((m) => m.asset === 'XRP'));
}

// ── PROOF 4 — THE MODEL OUT OF THE ORDER PATH ───────────────────────────────────────────────
console.log('Proof 4 — a model failure changes nothing to the orders:');
{
  const cycleSource = readFileSync(path.join(process.cwd(), 'src/s4/cycle.ts'), 'utf8');
  ok('the S4 cycle imports no model code (llm, prompt, coherence, explain)', !/from '\.\.\/decision\/(llm|prompt|promptV5|coherence|llmFailure)\.js'|from '\.\/explain\.js'/.test(cycleSource));
  const guard = readFileSync(path.join(process.cwd(), 'src/scheduler/cycleGuard.ts'), 'utf8');
  ok('the scheduler\'s cycle is S4, and decide() is no longer called', /s4Cycle\(\)/.test(guard) && !/\bdecide\(\)/.test(guard.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  const report: S4Report = {
    label: 'S4 testnet', ordersEnabled: true, firstCycle: false, closesDecided: [Date.parse('2026-11-07T00:00:00Z')],
    events: [{ closeMs: Date.parse('2026-11-07T00:00:00Z'), asset: 'ETH', kind: 'exit', close: 2200, sma50: 2500, statusBefore: 'in', statusAfter: 'out', highBefore: 2776.19, highAfter: 2776.19, thresholdPrice: 2220.95, armedAfter: true, daysOut: 0 }],
    lines: [{ asset: 'ETH', status: 'out', entryAtMs: null, high: null, exitAtMs: Date.parse('2026-11-07T00:00:00Z'), armed: true, entryPrice: null, lastMoveReason: 'sortie_s4', lastMoveAtMs: 0 }],
    plan: [], movements: [{ asset: 'ETH', side: 'sell', usd: 330, reason: 'sortie_s4' }], withheld: [], anomalies: [], blocked: null, nextDelayMinutes: 240,
  };
  const after = derivePortfolio([], { startingCapital: new Decimal(1000), reserveAsset: 'USDT', priceOf: () => null });
  const n = prepareS4Notification(report, after, '2026-11-07T00:03:00Z')!;
  const failing = { messages: { create: async () => { throw new Error('529 overloaded'); } } } as never;
  const res = await explainS4(n, { client: failing });
  ok('an API failure falls back to the code\'s own sentence', res.source === 'fallback' && res.text === fallbackExplanation(n) && /ETH a clôturé à 2.?200/.test(res.text));
  ok('and the notification still leaves, with the movement and the code\'s explanation', formatS4Activity(n, res.text).includes('Vente 330,00 $ d\'ETH') && formatS4Activity(n, res.text).includes(res.text));
  const answering = { messages: { create: async () => ({ stop_reason: 'end_turn', model: 'claude-haiku-5-5', usage: { input_tokens: 600, output_tokens: 60 }, content: [{ type: 'text', text: 'ETH est vendu.' }] }) } } as never;
  const fine = await explainS4(n, { client: answering });
  ok('when the model answers, its sentence is used — and it is pinned to claude-haiku-5-5', fine.source === 'model' && fine.text === 'ETH est vendu.' && fine.model === 'claude-haiku-5-5');
  ok('no movement, no notification and therefore no model call', prepareS4Notification({ ...report, movements: [], withheld: [] }, after, 'x') == null);
}

// ── PROOF 5 — A MISSING OR INCOMPLETE DAILY CANDLE ──────────────────────────────────────────
console.log('Proof 5 — the daily candle: never a decision on one that is missing or not closed:');
{
  const start = Date.parse('2026-08-01T00:00:00Z');
  const series = (days: number, skip?: number): Candle[] =>
    Array.from({ length: days }, (_, i) => ({ timestamp: start + i * DAY, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 })).filter((_, i) => i !== skip);
  const all = (days: number, skip?: number) => Object.fromEntries(ASSETS.map((a) => [a, a === 'ETH' ? series(days, skip) : series(days)]));
  const lastOpen = start + 59 * DAY;
  const read = readDailyTable(all(60), ASSETS, cfg.basket, lastOpen + DAY / 2);
  ok('the still-forming candle is dropped: the newest close is the one before it', read.ok && read.latestCloseMs === lastOpen);
  const due = dueCloses(lastOpen - DAY, lastOpen + DAY + 60_000);
  ok('two closes are due when the bot slept through one', due.length === 2 && due[1] === lastOpen + DAY);
  ok('the close not yet in the table blocks, naming it', read.ok && missingClose(read.table, due) != null && missingClose(read.table, due)!.includes(new Date(lastOpen + DAY).toISOString()));
  const holed = readDailyTable(all(60, 30), ASSETS, cfg.basket, lastOpen + DAY / 2);
  ok('a hole in one asset\'s daily series fails the read instead of shortening it', !holed.ok);
  const bad = Object.fromEntries(ASSETS.map((a) => [a, series(60).map((c, i) => (i === 40 && a === 'BNB' ? { ...c, close: Number.NaN } : c))]));
  ok('a non-finite close fails the read', !readDailyTable(bad, ASSETS, cfg.basket, lastOpen + DAY / 2).ok);
  const noEth = Object.fromEntries(ASSETS.filter((a) => a !== 'ETH').map((a) => [a, series(60)]));
  ok('an asset whose read failed fails the read', !readDailyTable(noEth, ASSETS, cfg.basket, lastOpen + DAY / 2).ok);
  const short = readDailyTable(Object.fromEntries(ASSETS.map((a) => [a, series(40)])), ASSETS, cfg.basket, start + 40 * DAY);
  ok('a close without its 50-day mean blocks', short.ok && missingClose(short.table, [start + 40 * DAY]) != null);
}

// ── PROOF 6 — A RESTART NEVER DECIDES THE SAME CLOSE TWICE ──────────────────────────────────
console.log('Proof 6 — restart: the state picks up exactly, no close is decided twice:');
{
  const tape = prepareExitDevelopmentTape(process.cwd());
  const table = buildDailyTable(tape, cfg.basket);
  const closes = table.rows.filter((r) => r.closeMs >= Date.parse('2022-01-01') && r.closeMs <= Date.parse('2022-06-30')).map((r) => r.closeMs);
  const held: Record<string, HoldingView> = Object.fromEntries(ASSETS.map((a) => [a, { held: true, entryAtMs: Date.parse('2021-12-01T00:00:00Z') }]));
  const fresh: S4Line[] = ASSETS.map((asset) => ({ asset, status: 'in', entryAtMs: Date.parse('2021-12-01T00:00:00Z'), high: null, exitAtMs: null, armed: false, entryPrice: null, lastMoveReason: null, lastMoveAtMs: null }));
  const straight = applyDailyCloses({ lines: fresh, table, closes, holdings: held });
  // Interrupted: the first half is decided and "persisted" (a JSON round trip), the process dies,
  // the next process reads the state back and asks for what is due after the last close.
  const half = Math.floor(closes.length / 2);
  const first = applyDailyCloses({ lines: fresh, table, closes: closes.slice(0, half), holdings: held });
  const persisted = JSON.parse(JSON.stringify(first.lines)) as S4Line[];
  const resumedDue = dueCloses(closes[half - 1]!, closes.at(-1)!);
  const second = applyDailyCloses({ lines: persisted, table, closes: resumedDue, holdings: held });
  ok('the resumed run consumes exactly the closes not yet consumed', resumedDue.length === closes.length - half && resumedDue[0] === closes[half]);
  ok('and ends in the very state of an uninterrupted run', JSON.stringify(second.lines) === JSON.stringify(straight.lines));
  ok('each (close, asset) is decided once across the two processes', first.events.length + second.events.length === straight.events.length && new Set([...first.events, ...second.events].map((e) => `${e.closeMs}:${e.asset}`)).size === straight.events.length);
  ok('a second cycle after the last close has nothing due', dueCloses(closes.at(-1)!, closes.at(-1)! + DAY - 1).length === 0);
  ok('the period exercised an exit', straight.events.some((e) => e.kind === 'exit'));
  ok('the next cycle is the next 4h boundary plus the offset', nextCycleDelayMinutes(Date.parse('2026-11-06T00:04:00Z'), H4, 3) === 239 && nextCycleDelayMinutes(Date.parse('2026-11-06T03:59:00Z'), H4, 3) === 4);
  // An execution that died before writing its entries: the pending marker repairs them.
  const pending = { decisionId: 9, atMs: Date.parse('2026-11-07T04:03:00Z'), openCandidates: ['XRP'], legs: [] };
  const rep = reconcileEntries({ lines: [{ ...fresh[3]!, asset: 'XRP', entryAtMs: null }], held: { XRP: true }, atMs: Date.parse('2026-11-07T08:03:00Z'), pending });
  ok('an interrupted fill gets the instant of the cycle that placed it', rep.lines[0]!.entryAtMs === pending.atMs && rep.anomalies.length === 1);
}

// ── PROOF 7 — THE RECONSTRUCTED START ───────────────────────────────────────────────────────
console.log('Proof 7 — the reconstructed start:');
{
  const recon: Reconstruction = JSON.parse(readFileSync(path.join(process.cwd(), 'out/s4/reconstruction.json'), 'utf8'));
  ok('the reconstruction reproduced the sealed result before being trusted (1 101,50 $)', recon.checks.sealedCapital === 1101.5 && recon.checks.regimePrefixDivergence == null && recon.checks.trajectoryPrefixDivergence == null);
  ok('and the state does not depend on its start point', recon.checks.convergence.every((c) => JSON.stringify(c.lines) === JSON.stringify(recon.checks.convergence[0]!.lines)));
  const seeded = seedLinesOf(recon);
  ok('the seed is the bench\'s lines, field for field', ASSETS.every((a) => {
    const s = seeded.find((l) => l.asset === a)!;
    const b = recon.lines.find((l) => l.asset === a)!;
    return s.status === b.status && s.entryAtMs === b.entryAtMs && s.high === b.high && s.exitAtMs === b.exitAtMs && s.armed === b.armed;
  }));
  const btc = seeded.find((l) => l.asset === 'BTC')!;
  if (btc.status === 'in') {
    const topped = reconcileEntries({ lines: [btc], held: { BTC: true }, opened: {}, atMs: Date.parse('2026-11-07T00:03:00Z') });
    ok('topping BTC up from ~5 % keeps its entry and its high (not a new entry)', topped.lines[0]!.entryAtMs === btc.entryAtMs && topped.lines[0]!.high === btc.high);
    const t: TrailingLine = { status: 'in', entryAtMs: btc.entryAtMs, high: btc.high, exitAtMs: null, armed: false };
    stepTrailingLine(t, { asset: 'BTC', closeMs: recon.lastCloseMs + DAY, close: btc.high! * 0.79, mean: btc.high!, holding: { held: true, entryAtMs: btc.entryAtMs } }, 10);
    ok('so the reconstructed high is the one the next close is judged against', t.status === 'out');
  }
}

console.log(`\n${passed} S4 checks passed.`);
