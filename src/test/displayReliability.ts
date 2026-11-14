import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { completeS4Notification, formatS4Activity, prepareS4Notification, type DecidingCloseReader } from '../alerting/s4Activity.js';
import { buildDailySummary, formatDailySummary, readTwice, type DailySummaryInputs } from '../alerting/dailySummary.js';
import type { DecideResult } from '../decision/decide.js';
import { buildEquitySnapshot } from '../persistence/equitySnapshots.js';
import {
  bookWith,
  decidingFromRows,
  feesOf,
  reportOf,
  type StoredJournalRow,
  type StoredS4Cycle,
} from '../replay/s4StoredCycle.js';
import type { S4CloseEvent, S4Line } from '../s4/core.js';
import { s4MoveReason, type S4Report } from '../s4/cycle.js';
import { decidingFromEvent, decidingFromJournal, formatS4Motif, type S4MotifFacts } from '../s4/motif.js';
import { photoBookOf, runCycleWithTimeout } from '../scheduler/cycleGuard.js';

/**
 * WHAT THE BOT SHOWS — the proofs of the chantier du 14/11/2026.
 *
 *   1. the motif of an S4 movement is the code's: the three real trading cycles of the pilot
 *      (3278, 3293, 3323) replayed on the rows production recorded, then the cases production has
 *      not met yet (a rebuy, a decision executed by a later cycle, a journal that cannot be read);
 *   2. the daily summary measures the pilot from the pilot's start, names each base, and says
 *      why a number is missing — the 09/11 dash, replayed;
 *   3. the photo of a cycle that traded is the book after its orders and their fees.
 *
 * The fixture is what `npm run replay:display -- --fixture …` read from production (read-only):
 * decision rows, booked intents, journal rows and stored photos, untouched.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}
/** fr-FR groups thousands with a narrow no-break space: compared as a plain space here. */
const plain = (s: string): string => s.replace(/[  ]/g, ' ');

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'src/test/fixtures/s4-pilot-cycles.json'), 'utf8')) as {
  cycles: StoredS4Cycle[];
  journal: StoredJournalRow[];
};
const cycleOf = (id: number): StoredS4Cycle => fixture.cycles.find((c) => c.id === id)!;
const journalReader: DecidingCloseReader = async (asset, kind, closeMs) => decidingFromRows(fixture.journal, asset, kind, closeMs);
const replay = async (id: number): Promise<string> => {
  const cycle = cycleOf(id);
  const n = prepareS4Notification(reportOf(cycle), bookWith(cycle.book, cycle.intents, cycle.reserveAsset), cycle.createdAt)!;
  return plain(formatS4Activity(await completeS4Notification(n, journalReader)));
};

// ── 1. THE MOTIF ────────────────────────────────────────────────────────────────────────────
console.log('Proof 1 — the motif of the pilot\'s three real trading cycles, from the recorded values:');
{
  const t3323 = await replay(3323);
  ok('3323 (14/11): BTC left on the 20 % trailing stop — close, threshold and high as journaled',
    t3323.includes('BTC vendu : clôture 68 314 sous le seuil de sortie 69 296 (20 % sous le plus-haut 86 620).'));
  ok('3323: and so did BNB', t3323.includes('BNB vendu : clôture 630,31 sous le seuil de sortie 639,53 (20 % sous le plus-haut 799,41).'));
  ok('3323: the 50-day mean — the cause the 14/11 message invented — appears nowhere', !/moyenne/i.test(t3323));
  ok('3323: the message ends on the book after the sales', t3323.includes('Allocation : 100% cash') && t3323.includes('Total : 961,00 $'));

  const t3293 = await replay(3293);
  ok('3293 (09/11): ETH left on the stop, with the high and the threshold the 09/11 message said were missing',
    t3293.includes('ETH vendu : clôture 2 127,46 sous le seuil de sortie 2 220,95 (20 % sous le plus-haut 2 776,19).'));

  const t3278 = await replay(3278);
  ok('3278 (06/11): the transition is announced as such', t3278.includes('Premier cycle du pilote : le portefeuille rejoint l\'état S4.'));
  ok('3278: XRP is sold because S4 holds it out, since the close the bench state carries',
    t3278.includes('XRP vendu : hors marché pour S4 depuis la clôture du 30/10, sa part reste en cash.'));
  ok('3278: BTC is brought to its target, with the high and the exit threshold it is now followed on',
    t3278.includes('BTC acheté : en marché pour S4, ligne portée de 5,1 % à sa cible de 32,5 % (plus-haut suivi 86 620, seuil de sortie 69 296).'));
  ok('3278: every leg has its motif', ['ETH acheté :', 'BNB acheté :', 'BTC acheté :', 'XRP vendu :'].every((s) => t3278.includes(s)));
}

console.log('Proof 1b — the live path and the journal give the same sentence:');
{
  // Live, the cycle that consumed the close holds the event `commitCloses` journals. Rebuilt
  // here from the journal row itself, and handed to the notification the way the cycle does.
  const cycle = cycleOf(3323);
  const closeMs = Date.parse(cycle.closesDecided[0]!);
  const events: S4CloseEvent[] = fixture.journal
    .filter((r) => Date.parse(r.close_at) === closeMs)
    .map((r) => ({
      closeMs, asset: r.asset, kind: 'exit', close: Number(r.close), sma50: Number(r.sma50), statusBefore: 'in', statusAfter: 'out',
      highBefore: Number(r.high_after), highAfter: Number(r.high_after), thresholdPrice: Number(r.threshold_price), armedAfter: true, daysOut: 0,
    }));
  const after = bookWith(cycle.book, cycle.intents, cycle.reserveAsset);
  let reads = 0;
  const counting: DecidingCloseReader = async (...args) => { reads += 1; return journalReader(...args); };
  const live = await completeS4Notification(prepareS4Notification({ ...reportOf(cycle), events }, after, cycle.createdAt)!, counting);
  ok('a movement decided by this cycle needs no read at all', reads === 0 && live.movements.every((m) => m.deciding != null && m.decidedThisCycle));
  ok('and its text is the replay\'s, character for character', plain(formatS4Activity(live)) === (await replay(3323)));
  ok('the event and its journal row are the same record',
    JSON.stringify(decidingFromEvent(events.find((e) => e.asset === 'BTC')!, null)) ===
    JSON.stringify(decidingFromRows(fixture.journal, 'BTC', 'exit', closeMs)));
}

console.log('Proof 1c — what production has not met yet:');
{
  const base: S4MotifFacts = {
    asset: 'XRP', side: 'buy', reason: 'rachat_s4', decidingCloseMs: null, deciding: null, decidedThisCycle: true,
    lineStatus: 'in', high: null, exitThreshold: null, exitAtMs: null, currentPercent: 0, targetPercent: 15,
  };
  // A REBUY. XRP has been out since the close of 30/10; the journal counts 15 days at the close of
  // 14/11. A close back above the 50-day mean on 15/11 lets it in after 16 days.
  const exitMs = Date.parse('2026-10-30T00:00:00Z');
  const rebuyMs = Date.parse('2026-11-15T00:00:00Z');
  const event: S4CloseEvent = { closeMs: rebuyMs, asset: 'XRP', kind: 'rebuy', close: 1.3501, sma50: 1.3204, statusBefore: 'out', statusAfter: 'in', highBefore: null, highAfter: null, thresholdPrice: null, armedAfter: false, daysOut: null };
  const fromEvent = decidingFromEvent(event, exitMs);
  const fromJournal = decidingFromJournal(
    { close_at: '2026-11-15T00:00:00+00:00', event: 'rebuy', close: '1.3501', sma50: '1.3204', high_after: null, threshold_price: null, days_out: null },
    { close_at: '2026-11-14T00:00:00+00:00', days_out: 15 },
  );
  ok('a rebuy\'s days out: the exit date (live) and the journal\'s last out-of-market row agree', fromEvent?.daysOut === 16 && JSON.stringify(fromEvent) === JSON.stringify(fromJournal));
  ok('the rebuy motif gives the days out and the close against the 50-day mean',
    plain(formatS4Motif({ ...base, decidingCloseMs: rebuyMs, deciding: fromEvent })) ===
    'XRP racheté : 16 jours hors marché (minimum 10), clôture 1,3501 repassée au-dessus de la moyenne 50 jours 1,3204.');
  ok('a rebuy that waited for a freeze says which close decided it',
    plain(formatS4Motif({ ...base, decidingCloseMs: rebuyMs, deciding: fromEvent, decidedThisCycle: false })).endsWith('Rachat décidé à la clôture du 15/11, exécuté à ce cycle.'));
  ok('a rebuy whose days out are not on record states the rule\'s minimum, not a number',
    plain(formatS4Motif({ ...base, deciding: { ...fromEvent!, daysOut: null } })).includes('au moins 10 jours hors marché (durée exacte non enregistrée)'));

  // The whole live chain on a rebuy: the line the cycle found out, the event, the buy.
  const out: S4Line = { asset: 'XRP', status: 'out', entryAtMs: null, high: null, exitAtMs: exitMs, armed: true, entryPrice: null, lastMoveReason: 'transition_initiale', lastMoveAtMs: 0 };
  const back: S4Line = { ...out, status: 'in', exitAtMs: null, armed: false, lastMoveReason: 'rachat_s4', lastMoveAtMs: rebuyMs };
  const reason = s4MoveReason({ firstCycle: false, side: 'buy', line: back, heldBefore: false });
  const report: S4Report = {
    label: 'S4 testnet', ordersEnabled: true, firstCycle: false, closesDecided: [rebuyMs], events: [event],
    lines: [back], linesBefore: [out], linesAtDecision: [back],
    plan: [{ asset: 'XRP', gate: 'actionable', state: 'free', currentPercent: 0, targetPercent: 15, hold: false }],
    movements: [{ asset: 'XRP', side: 'buy', usd: 144.1, reason }], withheld: [], anomalies: [], blocked: null, nextDelayMinutes: 240,
  };
  const book = bookWith({ cash: 961, equity: 961, positions: [] }, [], 'USDT');
  const text = plain(formatS4Activity(prepareS4Notification(report, book, '2026-11-15T00:05:00Z')!));
  ok('a rebuy decided and filled in one cycle is attributed and explained without any read',
    reason === 'rachat_s4' && text.includes('Achat 144,10 $ de XRP') && text.includes('XRP racheté : 16 jours hors marché (minimum 10), clôture 1,3501 repassée au-dessus de la moyenne 50 jours 1,3204.'));

  // AN EXIT EXECUTED BY A LATER CYCLE (its order had not filled): no event, the journal is read.
  const cycle = cycleOf(3323);
  const later = { ...reportOf(cycle), closesDecided: [] };
  const after = bookWith(cycle.book, cycle.intents, cycle.reserveAsset);
  const deferred = plain(formatS4Activity(await completeS4Notification(prepareS4Notification(later, after, '2026-11-14T04:05:00Z')!, journalReader)));
  ok('an exit executed one cycle later keeps its values, and says which close decided it',
    deferred.includes('BTC vendu : clôture 68 314 sous le seuil de sortie 69 296 (20 % sous le plus-haut 86 620). Sortie décidée à la clôture du 14/11, exécutée à ce cycle.'));

  // THE JOURNAL CANNOT BE READ: no number is made up, the cause still comes from the code.
  for (const [label, reader] of [
    ['returns nothing', async () => null],
    ['throws', async () => { throw new Error('timeout'); }],
  ] as Array<[string, DecidingCloseReader]>) {
    const blind = plain(formatS4Activity(await completeS4Notification(prepareS4Notification(later, after, '2026-11-14T04:05:00Z')!, reader)));
    ok(`a journal read that ${label}: the message leaves, names the rule, and says its values were not read`,
      blind.includes('BTC vendu : sortie S4, clôture journalière à 20 % ou plus sous le plus-haut depuis l\'entrée. Valeurs de la décision non relues dans le journal.') &&
      !/68 314|69 296|86 620|moyenne/.test(blind) && blind.includes('Vente 301,27 $ de BTC'));
  }

  // The rule exits AT or under the threshold; two prices compared are never printed equal.
  const exit: S4MotifFacts = { ...base, asset: 'BTC', side: 'sell', reason: 'sortie_s4', lineStatus: 'out', decidingCloseMs: rebuyMs, deciding: { kind: 'exit', closeMs: rebuyMs, close: 69296, sma50: 80000, high: 86620, threshold: 69296, daysOut: null } };
  ok('a close exactly on the threshold is said to be on it', plain(formatS4Motif(exit)).includes('clôture 69 296 au niveau du seuil de sortie 69 296'));
  ok('a close a hair under it is printed with enough digits to show the gap',
    plain(formatS4Motif({ ...exit, deciding: { ...exit.deciding!, close: 639.5279, threshold: 639.528, high: 799.41 } })).includes('clôture 639,5279 sous le seuil de sortie 639,528 '));
  ok('a drift rebalancing states the weight it left and the target it joined',
    plain(formatS4Motif({ ...base, asset: 'BTC', side: 'sell', reason: 'reequilibrage', currentPercent: 35.21, targetPercent: 32.5 })) === 'BTC vendu : rééquilibrage, ligne ramenée de 35,2 % à sa cible de 32,5 %.');

  // The attribution, unchanged by its extraction from the cycle.
  const line = (status: 'in' | 'out', lastMoveReason: S4Line['lastMoveReason']) => ({ status, lastMoveReason });
  ok('the cause of a leg: first cycle > sell on a line held out > buy opening a line just let back in > rebalancing',
    s4MoveReason({ firstCycle: true, side: 'sell', line: line('out', 'sortie_s4'), heldBefore: true }) === 'transition_initiale' &&
    s4MoveReason({ firstCycle: false, side: 'sell', line: line('out', 'sortie_s4'), heldBefore: true }) === 'sortie_s4' &&
    s4MoveReason({ firstCycle: false, side: 'sell', line: line('in', 'rachat_s4'), heldBefore: true }) === 'reequilibrage' &&
    s4MoveReason({ firstCycle: false, side: 'buy', line: line('in', 'rachat_s4'), heldBefore: false }) === 'rachat_s4' &&
    s4MoveReason({ firstCycle: false, side: 'buy', line: line('in', 'rachat_s4'), heldBefore: true }) === 'reequilibrage' &&
    s4MoveReason({ firstCycle: false, side: 'buy', line: line('in', 'transition_initiale'), heldBefore: false }) === 'reequilibrage' &&
    s4MoveReason({ firstCycle: false, side: 'buy', line: undefined, heldBefore: false }) === 'reequilibrage');
}

// ── 2. THE DAILY SUMMARY ────────────────────────────────────────────────────────────────────
console.log('Proof 2 — the daily summary: the pilot measured from its start, every base named:');
{
  const H = 3_600_000;
  const pilotStart = { startedAtMs: Date.parse('2026-11-06T12:15:04.908Z'), startingEquityUsd: 1034.4542397703 };
  const inputs = (over: Partial<DailySummaryInputs>): DailySummaryInputs => ({
    dateLabel: '14 novembre', nowMs: Date.parse('2026-11-14T08:00:05Z'), timezone: 'Europe/Paris', maxRefAgeMs: 24 * H + 245 * 60_000,
    latest: { equityUsd: 961, createdAtMs: Date.parse('2026-11-14T04:05:07Z'), allocation: [{ label: 'cash', weight: 100 }] },
    ref24h: { ok: true, value: { equityUsd: 973.41, createdAtMs: Date.parse('2026-11-13T04:05:20Z') } },
    startingCapital: { ok: true, value: 1000 },
    pilot: { ok: true, value: pilotStart },
    wakeups: { ok: true, value: 6 }, trades: { ok: true, value: 2 },
    ...over,
  });
  const t14 = formatDailySummary(buildDailySummary(inputs({})));
  ok('14/11: the pilot line measures S4 from its own start — −7,10 %, not the −3,90 % of the old base',
    t14.includes('Pilote S4 (depuis le 06/11) : -73.45$ (-7.10%)'));
  ok('14/11: the historical line says which base it measures against', t14.includes('Historique (base 1000$) : -39.00$ (-3.90%)') && !t14.includes('Depuis le début'));
  ok('14/11: the capital carries the local time it was valued at (the 04:05 UTC photo, at 9h)', t14.includes('Capital : 961$ (valorisé à 05h05)'));
  ok('the pilot line sits between the 24h line and the historical one',
    t14.indexOf('Sur 24h') < t14.indexOf('Pilote S4') && t14.indexOf('Pilote S4') < t14.indexOf('Historique'));

  // 06/11, 9h: the pilot starts four hours later. No pilot line that morning.
  const t06 = formatDailySummary(buildDailySummary(inputs({ dateLabel: '6 novembre', latest: { equityUsd: 1033.22, createdAtMs: Date.parse('2026-11-06T07:50:33Z'), allocation: [] }, pilot: { ok: true, value: null } })));
  ok('06/11 at 9h: the pilot has not started, the summary has no pilot line', !t06.includes('Pilote') && t06.includes('Historique (base 1000$) : +33.22$ (+3.32%)'));

  // THE 09/11 DASH. That morning the read of the 24h reference timed out; the line printed "—".
  const nine = { dateLabel: '9 novembre', nowMs: Date.parse('2026-11-09T08:00:05Z'), latest: { equityUsd: 1006.69, createdAtMs: Date.parse('2026-11-09T04:05:06Z'), allocation: [] } };
  const failed = formatDailySummary(buildDailySummary(inputs({ ...nine, ref24h: { ok: false } })));
  ok('09/11 replayed with its failed read: the line says the read failed', failed.includes('Sur 24h : indisponible (lecture en échec)') && !/Sur 24h : —/.test(failed));
  const read = formatDailySummary(buildDailySummary(inputs({ ...nine, ref24h: { ok: true, value: { equityUsd: 1032.2, createdAtMs: Date.parse('2026-11-08T04:05:46Z') } } })));
  ok('09/11 with the reference read: the number that was there all along (27h54 old, inside the 28h05 bound)', read.includes('Sur 24h : -25.51$ (-2.47%)'));
  const none = formatDailySummary(buildDailySummary(inputs({ ...nine, ref24h: { ok: true, value: null } })));
  ok('no reference at all is a different line from a failed read', none.includes('Sur 24h : — (pas de photo de référence à 24h)'));
  const stale = formatDailySummary(buildDailySummary(inputs({ ...nine, ref24h: { ok: true, value: { equityUsd: 1050, createdAtMs: Date.parse('2026-11-06T04:00:00Z') } } })));
  ok('a reference too old to be called 24h is still refused, with its reason', stale.includes('Sur 24h : — (pas de photo de référence à 24h)'));

  const blind = formatDailySummary(buildDailySummary(inputs({ pilot: { ok: false }, startingCapital: { ok: false }, wakeups: { ok: false } })));
  ok('each failed read degrades its own line, by name — never a zero, never a silent dash',
    blind.includes('Pilote S4 : indisponible (lecture en échec)') && blind.includes('Historique : indisponible (lecture en échec)') &&
    blind.includes('Activité : indisponible (lecture en échec)') && blind.includes('Capital : 961$'));
  ok('an unset starting capital is said to be unset', formatDailySummary(buildDailySummary(inputs({ startingCapital: { ok: true, value: null } }))).includes('Historique : — (capital de départ non renseigné)'));

  // One retry. A transient failure costs a second attempt, not the day's number.
  let calls = 0;
  const flaky = await readTwice('flaky', async () => { calls += 1; if (calls === 1) throw new Error('timeout'); return 42; });
  ok('a read that fails once is tried again, and its value is used', flaky.ok && flaky.value === 42 && calls === 2);
  calls = 0;
  const realWarn = console.warn;
  console.warn = () => {};
  const dead = await readTwice('dead', async () => { calls += 1; throw new Error('timeout'); });
  console.warn = realWarn;
  ok('a read that fails twice is reported as a failure — and not tried a third time', !dead.ok && calls === 2);
  calls = 0;
  const fine = await readTwice('fine', async () => { calls += 1; return null; });
  ok('an empty answer is an answer: read once, never mistaken for a failure', fine.ok && fine.value === null && calls === 1);
}

// ── 3. THE PHOTO ────────────────────────────────────────────────────────────────────────────
console.log('Proof 3 — the photo of a cycle that traded is the book after its orders and fees:');
{
  const sameHoldings = (a: Array<{ asset: string; qty: number }>, b: Array<{ asset: string; qty: number }>): boolean =>
    JSON.stringify(a.map((p) => [p.asset, p.qty]).sort()) === JSON.stringify(b.map((p) => [p.asset, p.qty]).sort());
  for (const cycle of fixture.cycles) {
    const before = buildEquitySnapshot(cycle.id, bookWith(cycle.book, [], cycle.reserveAsset));
    const after = buildEquitySnapshot(cycle.id, bookWith(cycle.book, cycle.intents, cycle.reserveAsset));
    ok(`${cycle.id}: the photo production stored is the book BEFORE the orders — the defect`,
      cycle.photo!.equity_usd === before.equity_usd && cycle.photo!.cash_usd === before.cash_usd && sameHoldings(cycle.photo!.positions, before.positions));
    ok(`${cycle.id}: the new photo is lower by the cycle's fees (${feesOf(cycle.intents).toFixed(2)} $), to the cent`,
      Math.abs(before.equity_usd - feesOf(cycle.intents) - after.equity_usd) < 0.006 && after.equity_usd < before.equity_usd);
    ok(`${cycle.id}: and it holds exactly what the next cycle (#${cycle.nextPhoto!.decision_id}) found — same cash, same quantities`,
      after.cash_usd === cycle.nextPhoto!.cash_usd && sameHoldings(after.positions, cycle.nextPhoto!.positions));
  }
  const c3323 = cycleOf(3323);
  const photo3323 = buildEquitySnapshot(3323, bookWith(c3323.book, c3323.intents, c3323.reserveAsset));
  ok('3323: 961,00 $, all cash — no longer 961,49 $ with BTC and BNB', photo3323.equity_usd === 961 && photo3323.cash_usd === 961 && photo3323.positions.length === 0);

  // The seam itself: what the scheduler photographs.
  const pre = bookWith(c3323.book, [], c3323.reserveAsset);
  const post = bookWith(c3323.book, c3323.intents, c3323.reserveAsset);
  ok('the photo book is the post-trade book when the cycle has one', photoBookOf({ portfolio: pre, portfolioAfter: post }) === post);
  ok('and the book it read when it returned before any order', photoBookOf({ portfolio: pre, portfolioAfter: null }) === pre);
  const result = { status: 'decided', decisionId: 3323, row: { applied_delay_minutes: 240 }, marketData: 'sighted', portfolio: pre, portfolioAfter: post, llmFailure: null } as unknown as DecideResult;
  const outcome = await runCycleWithTimeout(() => Promise.resolve(result), 1000);
  ok('the scheduler\'s prepared photo is the post-trade one', JSON.stringify(outcome.equitySnapshot) === JSON.stringify(photo3323));
  const held = { ...result, portfolioAfter: pre } as DecideResult;
  ok('a cycle that booked nothing is photographed as it was', JSON.stringify((await runCycleWithTimeout(() => Promise.resolve(held), 1000)).equitySnapshot) === JSON.stringify(buildEquitySnapshot(3323, pre)));
}

console.log(`\n${passed} display-reliability checks passed.`);
