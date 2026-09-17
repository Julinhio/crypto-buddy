import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { dec } from '../money.js';
import type { PriceLookup } from '../portfolio/derive.js';
import {
  cutIntoSegments,
  equalWeightUnderCaps,
  expectedComparisons,
  isRepresentableAtJournalPrecision,
  settledCutoff,
  openBook,
  stepWitness,
  valueBook,
  witnessRow,
  type WitnessBook,
} from '../exposure/witness.js';
import {
  buildEpisodes,
  judgeC8,
  readEpisodeReaction,
  type AdoptionEpisode,
  type DecisionSummary,
  type JournalCorrectionLine,
} from '../exposure/adoption.js';
import {
  allocationsAgree,
  bandSettledCutoff,
  attributeLegs,
  journaledClampedAllocation,
  judgeW4,
  judgeW5,
  modelIntentionFor,
  realBandLegs,
  type CounterfactualCycle,
} from '../exposure/counterfactual.js';
import { assessBand, type AssessBandInput } from '../exposure/band.js';
import { correctToBand, type CorrectInput, type CorrectionOutcome } from '../exposure/correct.js';
import { clampAllocation } from '../risk/clamp.js';
import type { TransitionGate } from '../transition/gate.js';
import type { VirtualPortfolio } from '../portfolio/derive.js';

/**
 * THE PROOFS OF THE TWO WITNESSES — brick 3 of the constrained-exposure pilot.
 *
 * No network, no database, no LLM, no clock. Everything is a fixture.
 *
 * A witness is only worth what its FIDELITY is worth. If it ignored the movement floor, or the
 * fees, or a missing price, it would be a benchmark no portfolio could ever have held, and
 * every comparison drawn against it would flatter or damn the bot for the wrong reason. So the
 * proofs here are mostly about the plumbing the witnesses are made to carry — and about the one
 * thing they must NOT carry, the bot's own freezes.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();
const RESERVE = 'USDT';
const UNIVERSE = ['BTC', 'ETH', 'BNB', 'XRP'];
const CAPS: Record<string, number> = { BTC: 35, ETH: 35, BNB: 20, XRP: 15 };
const capOf = (asset: string): number => CAPS[asset] ?? 15;
/** Every price is 100, so a point of equity is a point of price — the arithmetic stays legible. */
const priceOf: PriceLookup = (asset) => (asset === RESERVE ? dec(1) : dec(100));
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;
/**
 * The tolerance for a figure SUMMED over several six-decimal weights. Three lines rounded down
 * can lose three millionths between them, and a check tighter than the rounding would be
 * testing the rounding rather than the rule.
 */
const SUM_TOL = 1e-5;
const exposureOf = (allocation: Record<string, number>): number =>
  Object.entries(allocation)
    .filter(([asset]) => asset !== RESERVE)
    .reduce((sum, [, weight]) => sum + weight, 0);

// ── PROOF 1 — equal weight, until a cap says otherwise ───────────────────────────────
console.log('Proof 1 — the witnesses split equally, and the caps are what bends it:');
{
  const easy = equalWeightUnderCaps(40, UNIVERSE, capOf, RESERVE);
  ok('40 points split four ways is 10 a line', UNIVERSE.every((a) => near(easy.allocation[a]!, 10)));
  ok('and the reserve takes the rest', near(easy.allocation[RESERVE]!, 60));
  ok('no line is clipped, nothing is redistributed', easy.clipped.length === 0 && easy.redistributedPoints === 0);

  // THE CASE THE ARBITRATION IS ABOUT. At 70 points the equal share is 17.5 and XRP is capped
  // at 15, so equal weighting and the caps cannot both hold. The contract's priority is the
  // EXPOSURE — "Bot − E measures selection at identical exposure" is only true if E really
  // carries the bot's exposure — so the excess is redistributed onto the lines that still have
  // room, and none of it goes back to cash.
  const capped = equalWeightUnderCaps(70, UNIVERSE, capOf, RESERVE);
  ok('[arbitrage] XRP is pinned at its cap', near(capped.allocation.XRP!, 15));
  ok('and it is named as clipped', capped.clipped.length === 1 && capped.clipped[0] === 'XRP');
  ok('the exposure is preserved to the point', near(exposureOf(capped.allocation), 70, SUM_TOL));
  ok(
    'nothing fell back to cash',
    capped.unplaceablePoints === 0 && near(capped.allocation[RESERVE]!, 30, SUM_TOL),
  );
  ok(
    'the 2.5 points XRP could not take were redistributed',
    near(capped.redistributedPoints, 2.5, SUM_TOL) && near(capped.placedExposurePercent, 70, SUM_TOL),
  );
  ok(
    'onto the three lines that had room, equally',
    near(capped.allocation.BTC!, 55 / 3, SUM_TOL) &&
      near(capped.allocation.ETH!, 55 / 3, SUM_TOL) &&
      near(capped.allocation.BNB!, 55 / 3, SUM_TOL),
  );

  // A SECOND ROUND OF CLIPPING. At 90 points BNB (20) is reached as well once XRP's excess has
  // been poured on: the re-pour must clip again rather than overfill.
  const twice = equalWeightUnderCaps(90, UNIVERSE, capOf, RESERVE);
  ok(
    '[deuxième tour] BNB is reached in its turn',
    near(twice.allocation.BNB!, 20, SUM_TOL) && near(twice.allocation.XRP!, 15, SUM_TOL),
  );
  ok('and no cap is ever exceeded', UNIVERSE.every((a) => twice.allocation[a]! <= capOf(a) + 1e-9));
  ok('the exposure is still held whole', near(exposureOf(twice.allocation), 90, SUM_TOL));

  // WHAT NO CAP CAN TAKE. The caps total 105; ask for 110 and 5 points have nowhere to go.
  // They are REPORTED, not absorbed — the only route back to cash there is.
  const impossible = equalWeightUnderCaps(110, UNIVERSE, capOf, RESERVE);
  ok(
    '[inplaçable] every line sits at its cap',
    UNIVERSE.every((a) => near(impossible.allocation[a]!, capOf(a), SUM_TOL)),
  );
  ok('the 5 unplaceable points are named', near(impossible.unplaceablePoints, 5, SUM_TOL));
  ok(
    'and the exposure stops at what the caps can hold',
    near(exposureOf(impossible.allocation), 105, SUM_TOL),
  );

  const nothing = equalWeightUnderCaps(0, UNIVERSE, capOf, RESERVE);
  ok('[zéro] a defensive floor of 0 is all cash', near(nothing.allocation[RESERVE]!, 100) && exposureOf(nothing.allocation) === 0);

  for (const target of [0, 5, 17.3, 20, 45, 60, 70]) {
    const plan = equalWeightUnderCaps(target, UNIVERSE, capOf, RESERVE);
    const sum = Object.values(plan.allocation).reduce((a, b) => a + b, 0);
    ok(`the allocation sums to 100 at ${target} points (${sum.toFixed(6)})`, near(sum, 100, SUM_TOL));
  }
}

// ── PROOF 2 — a witness bears the same plumbing as the bot ───────────────────────────
console.log('\nProof 2 — the witness meets the executor\'s own floor, fees and refusals:');
{
  const open = openBook(RESERVE, dec(1000));
  const valued = valueBook(open, priceOf);
  ok('a witness opens fully in cash', valued.ok && valued.equity === 1000 && valued.exposurePercent === 0);

  const deployed = stepWitness({
    book: open,
    allocation: equalWeightUnderCaps(40, UNIVERSE, capOf, RESERVE).allocation,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
    logTag: ':test',
  });
  ok('it deploys through real movements', !('gap' in deployed) && deployed.movements.length === 4);
  if ('gap' in deployed) throw new Error('unreachable');
  ok(
    '[frais] the equity it ends with is the equity it had, minus the fees it paid',
    near(deployed.equityAfter, deployed.equityBefore - deployed.feesQuote, SUM_TOL),
  );
  ok(
    'so the exposure REALISED is a hair under the exposure asked for',
    deployed.exposureAfterPercent < 40 && deployed.exposureAfterPercent > 39.9,
  );

  // THE MOVEMENT FLOOR, which is what makes a witness a portfolio rather than a curve. On a
  // 1000 book the floor is 20, and a one-point drift splits into four legs of 2.5 — nothing
  // moves, and the witness stays where it was.
  const drift = stepWitness({
    book: deployed.book,
    allocation: equalWeightUnderCaps(41, UNIVERSE, capOf, RESERVE).allocation,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
    logTag: ':test',
  });
  if ('gap' in drift) throw new Error('unreachable');
  ok('[seuil] a one-point drift sends nothing', drift.movements.length === 0);
  ok('and every refused leg says why', drift.suppressed.every((leg) => leg.reason === 'movement_floor'));
  ok('the book is exactly where it was', near(drift.exposureAfterPercent, deployed.exposureAfterPercent));
  ok('having paid nothing to stay there', drift.feesQuote === 0);

  // A HELD LINE WITH NO PRICE stops the whole cycle for that witness rather than valuing it at
  // a number nobody journaled. A fabricated valuation would flow into the equity, the weights,
  // the floor and every figure downstream.
  const blind: PriceLookup = (asset) => (asset === 'BTC' ? null : priceOf(asset));
  const gap = stepWitness({
    book: deployed.book,
    allocation: equalWeightUnderCaps(40, UNIVERSE, capOf, RESERVE).allocation,
    priceOf: blind,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
    logTag: ':test',
  });
  ok('[prix absent] a held line with no price refuses the cycle', 'gap' in gap && gap.gap === 'no_price');
  ok('and names the line', 'gap' in gap && gap.assets.join(',') === 'BTC');

  // A FULL EXIT closes the line — the one movement the floor never refuses.
  const exit = stepWitness({
    book: deployed.book,
    allocation: { BTC: 0, ETH: 0, BNB: 0, XRP: 0, [RESERVE]: 100 },
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
    logTag: ':test',
  });
  if ('gap' in exit) throw new Error('unreachable');
  ok('[sortie] a full exit is never refused by the floor', exit.movements.every((m) => m.fullExit));
  ok('and the lines are closed, not left with crumbs', exit.exposureAfterPercent === 0);
  ok('the cash is back, net of the fees', near(exit.equityAfter, exit.equityBefore - exit.feesQuote, SUM_TOL));
}

// ── PROOF 3 — the chain reproduces itself ────────────────────────────────────────────
console.log('\nProof 3 — same inputs, same book, twice:');
{
  const run = (): { exposure: number; equity: number; fees: number } => {
    let book: WitnessBook = openBook(RESERVE, dec(1000));
    let fees = 0;
    let exposure = 0;
    let equity = 1000;
    for (const target of [45, 45, 20, 20, 45, 70, 0, 45]) {
      const step = stepWitness({
        book,
        allocation: equalWeightUnderCaps(target, UNIVERSE, capOf, RESERVE).allocation,
        priceOf,
        feePercent: config.execution.feePercent,
        minMovementPercent: config.execution.minMovementPercent,
        logTag: ':test',
      });
      if ('gap' in step) continue;
      book = step.book;
      fees += step.feesQuote;
      exposure = step.exposureAfterPercent;
      equity = step.equityAfter;
    }
    return { exposure, equity, fees };
  };
  const first = run();
  const second = run();
  ok('the chain is deterministic', JSON.stringify(first) === JSON.stringify(second));
  ok('and it really moved — a frozen chain would prove nothing', first.fees > 0 && first.exposure > 0);
}

// ── PROOF 4 — the witnesses cannot see a gate, structurally ──────────────────────────
//
// ARBITRATED: a freeze, a stop or a transition describes a position OF THE BOT'S. A witness
// never took that entry. This is proven on the module graph rather than on behaviour, because
// "it happens not to call one today" is a property that a later edit deletes in silence.
console.log('\nProof 4 — no gate is reachable from the witnesses, and none is called:');
{
  const graph = moduleGraph(path.join(ROOT, 'src/exposure/witness.ts'));
  ok(`the witness module graph is ${graph.size} file(s)`, graph.size > 2);

  const gateFile = path.resolve(ROOT, 'src/transition/gate.ts');
  ok('transition/gate.ts is NOT in the runtime graph', !graph.has(gateFile));

  const source = readFileSync(path.join(ROOT, 'src/exposure/witness.ts'), 'utf8');
  ok(
    'and the witness calls no gate function',
    !/\bjudgeOrder\s*\(|\bjudgeVector\s*\(|\bapplyGate\s*\(|\bcapabilityOf\s*\(/.test(source),
  );
  ok(
    'nor reads a gate map',
    !/gateByAsset|TransitionGate/.test(source),
  );

  // A write can only be reached through a query builder, and a query builder starts at
  // `.from('<table>')`. The witnesses are a pure calculation: not one file in their graph can
  // build a query at all.
  const queryFiles = [...graph].filter((file) => /\.from\('/.test(readFileSync(file, 'utf8')));
  ok(
    `no file in the whole graph can build a query (${queryFiles.map((f) => path.basename(f)).join(', ') || 'none'})`,
    queryFiles.length === 0,
  );

  // AND THE REPLAY WRITES NOTHING. It does read the journal — it must — so the check is on the
  // verbs, not on the client.
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'the replay never inserts, upserts, updates or deletes',
    !/\.insert\(|\.upsert\(|\.update\(|\.delete\(|\.rpc\(/.test(replay),
  );
  ok(
    'and it declares its own contract of what it does not measure',
    /not_measured/.test(replay) && /aucun rendement, aucun drawdown/.test(replay),
  );
}

// ── PROOF 5 — what P must publish, and why ───────────────────────────────────────────
console.log('\nProof 5 — P publishes its target, its attainable exposure and its gap:');
{
  const plan = equalWeightUnderCaps(45, UNIVERSE, capOf, RESERVE);
  const step = stepWitness({
    book: openBook(RESERVE, dec(1000)),
    allocation: plan.allocation,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
    logTag: ':test',
  });
  if ('gap' in step) throw new Error('unreachable');
  const row = witnessRow(plan, step);
  ok('the theoretical target is published', near(row.targetExposurePercent, 45));
  ok('so is what the caps left attainable', near(row.attainableExposurePercent, 45));
  ok('and what the book really holds', row.realisedExposurePercent < 45 && row.realisedExposurePercent > 44.9);
  ok(
    'the gap is signed, and it is the fee, not a rounding',
    row.gapPoints < 0 && near(row.gapPoints, row.realisedExposurePercent - 45),
  );
  ok(
    'without these three we would compare a constrained bot to a witness assumed perfect',
    Number.isFinite(row.targetExposurePercent) &&
      Number.isFinite(row.attainableExposurePercent) &&
      Number.isFinite(row.gapPoints),
  );
}

// ── PROOF 6 — C8's reader: per executed episode, direction-aware, repetition first ────
//
// THE READER THAT STOOD HERE called "adoption" any next weight at or above the imposed one,
// whatever the direction of the correction — on a downward episode a model that merely repeated
// its own higher target read as adopting the band — and it read no real data at all. The one
// below is walked on the corpus's own episodes (1839 BNB/ETH upward from zero, 1922 ETH and
// 1951 BTC downward) and on the cases the protocol must cover explicitly.
console.log('\nProof 6 — C8 reads an executed episode, in its direction, and never calls a repetition adoption:');
{
  const up = (own: number | null, next: number | null) =>
    readEpisodeReaction({ direction: 'hausse', modelWeightPercent: own, imposedWeightPercent: 15, nextModelWeightPercent: next });
  const down = (own: number | null, next: number | null) =>
    readEpisodeReaction({ direction: 'baisse', modelWeightPercent: own, imposedWeightPercent: 9, nextModelWeightPercent: next });

  // (a) UPWARD, initial proposal ZERO — the 1839 BNB and ETH episodes.
  ok('[hausse depuis 0] the model asks for the imposed weight next: maintien', up(0, 15) === 'maintien');
  ok('or more than it: still maintien', up(0, 20) === 'maintien');
  ok('it stays at zero: REPETITION, not a fight — there is no further than zero', up(0, 0) === 'repetition');
  ok('it asks for something strictly between: rapprochement', up(0, 7) === 'rapprochement');
  // (b) UPWARD from a non-zero target.
  ok('[hausse depuis 5] repeating 5 is a repetition, never adoption', up(5, 5) === 'repetition');
  ok('going below its own 5 is a fight', up(5, 2) === 'lutte');
  ok('reaching 15 is maintien', up(5, 15) === 'maintien');
  // (c) DOWNWARD — the 1922 ETH (10 → 9) and 1951 BTC (10 → 8.75) episodes.
  ok('[baisse 10→9] repeating 10 is a REPETITION — the first reader called this adoption', down(10, 10) === 'repetition');
  ok('asking 9 or less is maintien', down(10, 9) === 'maintien' && down(10, 5) === 'maintien');
  ok('asking 9.5 is a rapprochement', down(10, 9.5) === 'rapprochement');
  ok('asking MORE than its own 10 is a fight', down(10, 12) === 'lutte');
  // (d) UNREADABLE.
  ok('a missing next proposal is non_mesurable, never a reading', up(0, null) === 'non_mesurable' && down(10, null) === 'non_mesurable');
  ok('a missing own proposal is non_mesurable too', up(null, 15) === 'non_mesurable');

  // (e) THE EPISODES ARE BUILT FROM THE JOURNAL, and a failed cycle in between is named and not
  // read. The fixture mirrors the corpus: the band buys BNB at 100 from a zero proposal; 101
  // fails; 102 is the first decided cycle and asks for 15.
  const line = (over: Partial<JournalCorrectionLine>): JournalCorrectionLine => ({
    decisionId: 100,
    asset: 'BNB',
    origin: 'allocation_de_secours',
    cause: 'aucune',
    rawWeightPercent: 0,
    clampedWeightPercent: 0,
    baseWeightPercent: 0,
    correctionPoints: 15,
    correctedWeightPercent: 15,
    plannedSide: 'buy',
    plannedNotionalQuote: 164,
    suppressedReason: null,
    suppressedNotionalQuote: null,
    bookedSide: 'buy',
    bookedNotionalQuote: 163.67,
    postCycleWeightPercent: 15.2,
    correctionMovesHolding: true,
    ...over,
  });
  const decisions: DecisionSummary[] = [
    { id: 100, status: 'decided', targetAllocation: { BNB: 0, XRP: 15, USDT: 85 } },
    { id: 101, status: 'guard_failed', targetAllocation: null },
    { id: 102, status: 'decided', targetAllocation: { BNB: 15, XRP: 15, USDT: 70 } },
    { id: 103, status: 'decided', targetAllocation: { BNB: 0, XRP: 15, USDT: 85 } },
  ];
  const noGate = (): string | null => 'actionable';
  const built = buildEpisodes({ lines: [line({})], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate }).episodes;
  ok('one executed leg → one episode', built.length === 1);
  const episode = built[0]!;
  ok('the reaction is read at 102, the first DECIDED cycle after it', episode.reaction?.decisionId === 102);
  ok('101 is named as skipped and is NOT a reaction', episode.skippedCycles.length === 1 && episode.skippedCycles[0]!.id === 101 && episode.skippedCycles[0]!.status === 'guard_failed');
  ok('the episode reads maintien on 102\'s 15, not on 103\'s later 0', episode.reading === 'maintien');
  // A planned-but-not-booked leg is NOT an episode; a model line is not one either.
  ok('a planned leg that never booked is not an episode', buildEpisodes({ lines: [line({ bookedSide: null, bookedNotionalQuote: null })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate }).episodes.length === 0);
  ok('nor is a line the band did not move', buildEpisodes({ lines: [line({ origin: 'modele', correctionPoints: 0, correctedWeightPercent: 0 })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate }).episodes.length === 0);
  // A later event breaks the attribution.
  const stopped = buildEpisodes({ lines: [line({})], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: (id, asset) => (id === 102 && asset === 'BNB' ? 'stop_exit' : 'actionable') }).episodes;
  ok('the code\'s stop on that line AT the reaction cycle makes it non_attribuable', stopped[0]!.reading === 'non_attribuable' && /stop_exit/.test(stopped[0]!.because ?? ''));
  // A stop verdict journaled on the FAILED cycle in between is an observation: no order, no
  // model consulted. It must not discard a valid reaction (first review round).
  const observedOnFailed = buildEpisodes({ lines: [line({})], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: (id, asset) => (id === 101 && asset === 'BNB' ? 'stop_exit' : 'actionable') }).episodes;
  ok('but a stop verdict on the failed cycle in between is an observation and leaves the reading intact', observedOnFailed[0]!.reading === 'maintien');
  // UNDER `observe` A VERDICT ACTS ON NOTHING: `applyGate` is a no-op and the model is told
  // nothing, so even a stop AT the reaction cycle leaves the reaction free (second review round).
  const observedMode = buildEpisodes({ lines: [line({})], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'observe', correctionAllowed: () => true, gateOf: (id, asset) => (id === 102 && asset === 'BNB' ? 'stop_exit' : 'actionable') }).episodes;
  ok('under `observe` the same stop at the reaction cycle is observational and the reading stays maintien', observedMode[0]!.reading === 'maintien');
  // A BOOKING ON A HELD CYCLE IS THE MODEL'S. The journal records the computed correction and
  // the real bookings even when the pilot held the correction back; a band-origin line with a
  // booked side there is the uncorrected bot's own trade, not an episode (third review round).
  const held = buildEpisodes({ lines: [line({})], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => false, gateOf: noGate }).episodes;
  ok('a booking on a cycle where the correction was not allowed to act is not an episode', held.length === 0);
  // THE HOLDING MUST HAVE MOVED BECAUSE OF THE BAND (fourth review round). `false` means the
  // corrected and uncorrected plans booked the same holding — the booking is the model's plan.
  // Null is unreadable: reported, never dropped in silence, and refused in the official window.
  const unmoved = buildEpisodes({ lines: [line({ correctionMovesHolding: false })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate });
  ok('correction_moves_holding = false excludes the line from the episodes', unmoved.episodes.length === 0 && unmoved.unreadable.length === 0);
  const unread = buildEpisodes({ lines: [line({ correctionMovesHolding: null })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate });
  ok('an unreadable correction_moves_holding is reported, not excluded in silence', unread.episodes.length === 0 && unread.unreadable.length === 1 && unread.unreadable[0]!.decisionId === 100 && unread.unreadable[0]!.asset === 'BNB');
  const refusedOfficial = judgeC8({ episodes: unread.episodes, decisions, fromDecisionId: 100, toDecisionId: 103, windowClosed: false, claimsOfficial: false, unreadable: unread.unreadable, official: true });
  ok('and in the official window the judge REFUSES, explicitly', refusedOfficial.status === 'fail' && /REFUS : correction_moves_holding illisible/.test(refusedOfficial.problems[0] ?? ''));
  const benchUnread = judgeC8({ episodes: unread.episodes, decisions, fromDecisionId: 100, toDecisionId: 103, windowClosed: false, claimsOfficial: false, unreadable: unread.unreadable, official: false });
  ok('on the bench it is not a refusal — the line is named and left out', benchUnread.status !== 'fail');
  // A band correction AT the reaction cycle does not break the attribution: the model proposed
  // before the band acted there, and that proposal is its reaction to this episode.
  const again = buildEpisodes({ lines: [line({}), line({ decisionId: 102, bookedSide: null })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate }).episodes;
  ok('a band correction at the reaction cycle itself leaves the reading attributable', again.find((e) => e.decisionId === 100)!.reading === 'maintien');
  ok('an episode with no decided cycle after it is non_mesurable', buildEpisodes({ lines: [line({ decisionId: 103 })], decisions, fromDecisionId: 100, toDecisionId: 103, transitionMode: 'enforce', correctionAllowed: () => true, gateOf: noGate }).episodes[0]!.reading === 'non_mesurable');

  // (f) THE READINGS STAY DESCRIPTIVE UNTIL THE CLOSURE, and the replay does not decide that.
  const open = judgeC8({ episodes: built, decisions, fromDecisionId: 100, toDecisionId: 103, windowClosed: false, claimsOfficial: false });
  ok('on an open window the judge passes but publishes nothing official', open.status === 'pass' && open.official === false);
  const closed = judgeC8({ episodes: built, decisions, fromDecisionId: 100, toDecisionId: 103, windowClosed: true, claimsOfficial: true });
  ok('on a closed window the same readings become the official C8', closed.status === 'pass' && closed.official === true);
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok('the replay names the risk_clamp bias next to every C8 reading', /BIAIS CONNU/.test(replay) && /risk_clamp/.test(replay) && /adoption consciente/.test(replay));
  ok('and builds its episodes from the journal, on every decision status', /buildEpisodes\(\{/.test(replay) && /loadDecisionSummaries\(/.test(replay) && !/loadDecisionSummaries[\s\S]{0,400}\.eq\('status', 'decided'\)/.test(replay));
}

// ── PROOF 7 — a hole in the data cuts the chain, it never compresses it ───────────
//
// The corpus happens to carry no internal hole today, so this rule would otherwise be one
// nothing ever exercises. Proven here on fixtures that DO have holes.
//
// The failure it prevents is silent: a chain that simply skips an unreconstructible cycle and
// carries on treats the interval as if it had not existed. If the witnesses would have
// rebalanced in it, every later row carries quantities, cash and fees that never were — and
// the gap counter still reports a clean run.
console.log('\nProof 7 — a gap cuts the chain and re-anchors it, never compresses it:');
{
  const entry = (id: number, ok: boolean, cause = 'no_prices') =>
    ok ? ({ ok: true as const, id, item: id }) : ({ ok: false as const, id, cause });

  // (a) A GAP BEFORE THE START costs nothing: no book exists to carry across it.
  const before = cutIntoSegments([entry(1, false), entry(2, false), entry(3, true), entry(4, true)]);
  ok('[avant le début] one segment only', before.segments.length === 1);
  ok('opened because the data starts, not to heal a cut', before.segments[0]!.opening === 'debut_reconstructible');
  ok('and it carries both complete cycles', before.segments[0]!.items.join(',') === '3,4');
  ok(
    'the two gaps are placed before the beginning',
    before.gaps.length === 2 && before.gaps.every((g) => g.placement === 'anterieur_au_debut'),
  );

  // (b) AN INTERNAL GAP CUTS. This is the whole point: cycle 3 breaks the chain, and 4 opens a
  // new one that re-anchors rather than resuming.
  const inside = cutIntoSegments([entry(1, true), entry(2, true), entry(3, false), entry(4, true), entry(5, true)]);
  ok('[trou interne] the chain is cut in two', inside.segments.length === 2);
  ok('the first segment stops AT the hole', inside.segments[0]!.items.join(',') === '1,2');
  ok('the second re-anchors after it', inside.segments[1]!.items.join(',') === '4,5');
  ok('and says why it opened', inside.segments[1]!.opening === 'reancrage_apres_trou');
  ok(
    'naming the cycle that broke it',
    inside.segments[1]!.brokenBy?.id === 3 && inside.segments[1]!.brokenBy?.cause === 'no_prices',
  );
  ok('the gap is placed INSIDE', inside.gaps.length === 1 && inside.gaps[0]!.placement === 'interne');
  ok(
    'no cycle is lost — every id is either reconstructed or a named gap',
    inside.segments.flatMap((seg) => seg.items).length + inside.gaps.length === 5,
  );

  // (c) A TERMINAL GAP CUTS NOTHING, because nothing resumes after it.
  const trailing = cutIntoSegments([entry(1, true), entry(2, true), entry(3, false), entry(4, false)]);
  ok('[trou terminal] one segment', trailing.segments.length === 1);
  ok(
    'and both trailing gaps stay terminal',
    trailing.gaps.length === 2 && trailing.gaps.every((g) => g.placement === 'terminal'),
  );

  // (d) A RUN OF HOLES breaks ONCE. The first one cut; the ones behind it were already inside
  // the hole and broke nothing of their own.
  const run = cutIntoSegments([
    entry(1, true),
    entry(2, false, 'no_gates'),
    entry(3, false, 'no_prices'),
    entry(4, true),
  ]);
  ok('[trou multiple] two segments, not three', run.segments.length === 2);
  ok('the break is attributed to the FIRST missing cycle', run.segments[1]!.brokenBy?.id === 2);
  ok(
    'and both holes are internal',
    run.gaps.length === 2 && run.gaps.every((g) => g.placement === 'interne'),
  );

  // (e) THE RE-ANCHOR IS REAL, not a label. Two segments, two freshly opened books: the second
  // starts from cash at its own opening equity, so nothing of the first crosses the frontier.
  const openings = [1000, 1500];
  const finals = openings.map((equity) => {
    const step = stepWitness({
      book: openBook(RESERVE, dec(equity)),
      allocation: equalWeightUnderCaps(40, UNIVERSE, capOf, RESERVE).allocation,
      priceOf,
      feePercent: config.execution.feePercent,
      minMovementPercent: config.execution.minMovementPercent,
      logTag: ':test',
    });
    if ('gap' in step) throw new Error('unreachable');
    return step;
  });
  ok(
    'a re-anchored book opens on its OWN equity, carrying nothing over',
    finals[0]!.equityBefore === 1000 && finals[1]!.equityBefore === 1500,
  );
  ok(
    'and reaches the same exposure from a different size — the chain restarts, it does not resume',
    near(finals[0]!.exposureAfterPercent, finals[1]!.exposureAfterPercent, SUM_TOL),
  );
}

// ── PROOF 8 — the replay stops at a point the journal has PROVEN finished ─────────
//
// A decision row appears before the cycle that wrote it has finished: production inserts it,
// THEN places the orders, THEN books the sovereign ledger, THEN journals the transition
// verdicts. Three queries fired together can therefore straddle that moment — one seeing the
// decision, another missing its ledger — and the replay would conclude, in silence, that the
// cycle booked nothing. That is the pre-trade-book defect, resurrected by a race.
//
// So the bound is not "the last id anyone can see". It is the last cycle the LAST-WRITTEN layer
// covers COMPLETELY, and every query is bounded by that same number.
console.log('\nProof 8 — a partially written cycle above the bound never enters the replay:');
{
  // Cycle 100 is finished: four verdicts, one per asset. 101 was caught mid-write — two
  // verdicts of four — and 102 has not reached the gate layer at all, though its decision row
  // and even its ledger are already visible.
  const coverage = new Map<number, Set<string>>([
    [98, new Set(['BTC', 'ETH', 'BNB', 'XRP'])],
    [100, new Set(['BTC', 'ETH', 'BNB', 'XRP'])],
    [101, new Set(['BTC', 'ETH'])],
  ]);
  const cutoff = settledCutoff(coverage, UNIVERSE);
  ok('[borne] the bound is the last COMPLETELY covered cycle', cutoff === 100);
  ok(
    'a partial batch does not settle anything — 101 is above the bound',
    cutoff != null && 101 > cutoff && 102 > cutoff,
  );

  // AND NONE OF THEIR DATA ENTERS. The filter every query applies is `id <= cutoff`, so it is
  // applied here to all three inputs at once.
  const decisions = [98, 100, 101, 102];
  const ledger = [
    { decision_id: 100, symbol: 'BTC/USDT' },
    { decision_id: 101, symbol: 'ETH/USDT' },
    { decision_id: 102, symbol: 'XRP/USDT' },
  ];
  const keptDecisions = decisions.filter((id) => id <= cutoff!);
  const keptLedger = ledger.filter((row) => row.decision_id <= cutoff!);
  const keptGates = [...coverage.keys()].filter((id) => id <= cutoff!);
  ok('no decision above the bound is replayed', keptDecisions.join(',') === '98,100');
  ok('no ledger row above the bound is read', keptLedger.map((r) => r.decision_id).join(',') === '100');
  ok('and no gate above the bound either', keptGates.join(',') === '98,100');
  ok(
    'so the half-written cycle contributes NOTHING — not even a gap',
    !keptDecisions.includes(101) && !keptLedger.some((r) => r.decision_id === 101),
  );

  // THE REFUSAL. No settled point at all is a refusal to replay, never an empty run: an empty
  // window would publish "0 cycle, all criteria green".
  ok('nothing complete means no bound', settledCutoff(new Map([[7, new Set(['BTC'])]]), UNIVERSE) === null);
  ok('and an empty journal means no bound', settledCutoff(new Map(), UNIVERSE) === null);
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'the replay refuses rather than running on a torn journal',
    /no point in the journal is provably settled|Refusing to replay/.test(replay),
  );
  ok(
    'and every query carries the same bound',
    replay.includes(".lte('id', cutoffId)") && replay.includes(".lte('decision_id', cutoffId)"),
  );
}

// ── PROOF 9 — the precision the reconstruction depends on is CHECKED ─────────────
//
// The post-trade book is seeded from a context whose quantities production rounds to eight
// decimals, then moved by the ledger's own deltas. That is equivalent to production's exact
// derivation only while both sit on the journal's grid — which they do, because a booked
// quantity is snapped to the venue step before it is journaled. Measured on the corpus: 2472
// comparisons, worst relative deviation 2.14e-16, i.e. machine noise.
//
// Measured is not guaranteed, so the assumption is an invariant that FAILS the run.
console.log('\nProof 9 — the journal precision is an invariant, not an assumption:');
{
  ok('a whole quantity fits', isRepresentableAtJournalPrecision(109.8));
  ok('so does one at the last journaled digit', isRepresentableAtJournalPrecision(0.00000001));
  ok('and a typical BTC size', isRepresentableAtJournalPrecision(0.00091234));
  ok(
    'a NINTH decimal does not',
    !isRepresentableAtJournalPrecision(0.000000001) && !isRepresentableAtJournalPrecision(0.123456789),
  );
  ok('neither does a non-finite value', !isRepresentableAtJournalPrecision(Number.NaN));
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'the replay THROWS on a quantity that no longer fits, rather than approximating',
    /does not fit the journal|no longer exact/.test(replay) && /throw new Error\(/.test(replay),
  );
  ok(
    'and it checks the ledger deltas too, not only the seed book',
    (replay.match(/isRepresentableAtJournalPrecision\(/g) ?? []).length >= 2,
  );
}

// ── PROOF 10 — a criterion that compared nothing may not call itself green ─────────
//
// W2 used to pass on "no drift" alone. A terminal cycle has no successor and a singleton
// segment has no pair at all, so a corpus made entirely of singletons would have passed with
// zero comparisons and a 0% agreement rate on display — the same family of emptiness as the
// circular version it replaced.
console.log('\nProof 10 — W2 owes a number of comparisons, computed from the segments:');
{
  ok('[fenêtre réelle] one segment of 619 owes 618 pairs × 4 assets', expectedComparisons([619], 4) === 2472);
  ok(
    'two segments owe one pair less than one segment of the same total',
    expectedComparisons([300, 319], 4) === 2468 && expectedComparisons([619], 4) === 2472,
  );
  ok('[singleton] a segment of one owes nothing', expectedComparisons([1], 4) === 0);
  ok(
    'and a corpus of singletons owes nothing at all — W2 cannot pass on it',
    expectedComparisons([1, 1, 1, 1], 4) === 0,
  );
  ok('an empty universe owes nothing either', expectedComparisons([619], 0) === 0);

  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'W2 requires the observed count to EQUAL the expected one',
    /const covered = expected > 0 && compared === expected;/.test(replay),
  );
  ok(
    'and it cannot pass without coverage, whatever the drifts say',
    /covered && drifts\.length === 0/.test(replay),
  );
  ok(
    'terminal cycles are published as uncheckable rather than assumed fine',
    /non contr\u00f4lables par W2/.test(replay),
  );
  ok(
    'and singleton segments are named NOT EXERCISED',
    /NON EXERC\u00c9S/.test(replay),
  );
}

// ── PROOF 11 — the official window is the pilot’s, or there is no official result ──
//
// §3.8 and §3.9 make three instants official — the activation, the 40% photograph, the 50%
// stop — and §7 adds the closure of the measurement window. A witness result is a PILOT result
// only when it is bounded by those and opened on the equity really recorded at the activation.
//
// Without an identity the replay is still useful, and still honest: it announces that it is a
// bench of the machinery and produces no official result at all.
console.log('\nProof 11 — the replay reads its bounds from the identity, or says it has none:');
{
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  // Containment rather than regexes: every one of these is a literal fragment of the source,
  // and an escaped regex would only add a way to get the escaping wrong.
  ok(
    'the window comes from the persisted identity',
    replay.includes('loadPilotWindow(supabase, requestedInstant)') && replay.includes("from('exposure_pilot')"),
  );
  ok(
    'the opening is the activation cycle, inclusive',
    replay.includes('decision.id < pilotWindow.fromDecisionId'),
  );
  ok(
    'the closing instant is chosen among the three persisted ones',
    replay.includes('alert_drawdown_decision_id') &&
      replay.includes('stopped_decision_id') &&
      replay.includes('window_closed_decision_id'),
  );
  ok(
    'and an endpoint past the settled point is REFUSED, never truncated',
    replay.includes('resolved.toDecisionId > cutoffId') &&
      replay.includes('le rejeu refuse plutot que de tronquer') &&
      !replay.includes('Math.min(pilotWindow.toDecisionId, cutoffId)'),
  );
  ok(
    'the books open on the equity recorded at the activation',
    replay.includes('openingEquityOverride != null ? openingEquityOverride'),
  );
  ok(
    'and only the first segment takes it — nothing crosses a re-anchor',
    replay.includes('segment.id === 1 && openingEquityOverride != null'),
  );
  ok(
    'a run that is not official says so, with the reason that refused it',
    replay.includes('PAS DE RÉSULTAT OFFICIEL') && replay.includes('AUCUN résultat officiel du pilote'),
  );
  ok(
    'and the refusal is the shared resolver\'s, not a local judgement',
    replay.includes('resolvePilotWindow(') && !replay.includes('official: true,'),
  );
  ok(
    'and with one it prints the bounds it is honouring',
    /FENÊTRE OFFICIELLE DU PILOTE/.test(replay),
  );
}

// ── PROOF 12 — B̂ is fed the model's intention, and 1839 attributes BNB and ETH to the band ──
//
// THE DEFECT, ON THE REAL NUMBERS OF THE ACTIVATION CYCLE. The book holds XRP 109.8 at 1.4208
// (14.48%) and 921.10 of cash; the state is constructive, the band [45, 70]; BTC and XRP are
// frozen, BNB and ETH actionable. Three allocations are on the row:
//
//   target_allocation   {XRP 15, USDT 85}                       the model's raw words
//   clamped (journal)   {XRP 15, USDT 85}                       what the corrector received
//   applied_allocation  {BNB 15, ETH 15, XRP 15, USDT 55}       what the band produced
//
// Fed the third, B̂ corrects a corrected target: nothing to do, every leg the model's. Fed the
// second, the band builds BNB and ETH — `allocation_de_secours`, the model never asked for
// them — and leaves XRP, which the model held at its target, alone.
console.log('\nProof 12 — the semantics of the three allocations, established on cycle 1839:');
{
  const reserve = 'USDT';
  const universe = ['BTC', 'ETH', 'BNB', 'XRP'];
  const prices: Record<string, number> = { BTC: 79934.72, ETH: 2500.64, BNB: 757.72, XRP: 1.4208 };
  const priceOf1839: PriceLookup = (asset) => (asset === reserve ? dec(1) : dec(prices[asset]!));
  const equity = 921.1 + 109.8 * 1.4208;
  const book1839: VirtualPortfolio = {
    reserveAsset: reserve,
    startingCapital: dec(1000),
    cash: dec(921.1),
    positions: [
      {
        asset: 'XRP',
        qty: dec(109.8),
        avgCost: dec(1.42),
        price: dec(1.4208),
        priceStale: false,
        value: dec(109.8 * 1.4208),
        unrealizedPnl: dec(0),
        weightPercent: dec(((109.8 * 1.4208) / equity) * 100),
      },
    ],
    equity: dec(equity),
    deployedPercent: dec(((109.8 * 1.4208) / equity) * 100),
    realizedPnl: dec(0),
    unrealizedPnl: dec(0),
    totalPnl: dec(0),
  };
  const gates1839 = new Map<string, TransitionGate>([
    ['BNB', 'actionable'],
    ['BTC', 'frozen'],
    ['ETH', 'actionable'],
    ['XRP', 'frozen'],
  ]);
  const raw1839 = { BNB: 0, BTC: 0, ETH: 0, XRP: 15, USDT: 85 };
  const applied1839 = { BNB: 15, BTC: 0, ETH: 15, XRP: 15, USDT: 55 };
  const journal1839: JournalCorrectionLine[] = [
    { decisionId: 1839, asset: 'BNB', origin: 'allocation_de_secours', cause: 'aucune', rawWeightPercent: 0, clampedWeightPercent: 0, baseWeightPercent: 0, correctionPoints: 15, correctedWeightPercent: 15, plannedSide: 'buy', plannedNotionalQuote: 164.18, suppressedReason: null, suppressedNotionalQuote: null, bookedSide: 'buy', bookedNotionalQuote: 163.67, postCycleWeightPercent: 15.2, correctionMovesHolding: true },
    { decisionId: 1839, asset: 'BTC', origin: 'modele', cause: 'gel', rawWeightPercent: 0, clampedWeightPercent: 0, baseWeightPercent: 0, correctionPoints: 0, correctedWeightPercent: 0, plannedSide: null, plannedNotionalQuote: null, suppressedReason: 'dust', suppressedNotionalQuote: 0.5, bookedSide: null, bookedNotionalQuote: null, postCycleWeightPercent: 0, correctionMovesHolding: false },
    { decisionId: 1839, asset: 'ETH', origin: 'allocation_de_secours', cause: 'aucune', rawWeightPercent: 0, clampedWeightPercent: 0, baseWeightPercent: 0, correctionPoints: 15, correctedWeightPercent: 15, plannedSide: 'buy', plannedNotionalQuote: 164.18, suppressedReason: null, suppressedNotionalQuote: null, bookedSide: 'buy', bookedNotionalQuote: 164.04, postCycleWeightPercent: 15.23, correctionMovesHolding: true },
    { decisionId: 1839, asset: 'XRP', origin: 'modele', cause: 'gel', rawWeightPercent: 15, clampedWeightPercent: 15, baseWeightPercent: 15, correctionPoints: 0, correctedWeightPercent: 15, plannedSide: null, plannedNotionalQuote: null, suppressedReason: 'movement_floor', suppressedNotionalQuote: 5.56, bookedSide: null, bookedNotionalQuote: null, postCycleWeightPercent: 14.49, correctionMovesHolding: false },
  ];
  const clamp = (target: Record<string, number>): Record<string, number> => clampAllocation(target, reserve, config).applied;

  // (a) THE INPUT. The journal's clamped weights are an allocation; they agree with the clamp
  // recomputed from the raw proposal; and the applied allocation is NOT that allocation.
  const journaled = journaledClampedAllocation(journal1839, universe, reserve);
  ok('the journal gives the clamped allocation, reserve closed to 100', journaled != null && journaled['XRP'] === 15 && journaled['BNB'] === 0 && journaled[reserve] === 85);
  ok('it agrees with the clamp recomputed from the raw proposal', allocationsAgree(journaled!, clamp(raw1839), universe, reserve).agree);
  ok('and it is NOT the applied allocation — which is the band\'s output', !allocationsAgree(journaled!, applied1839, universe, reserve).agree);
  const official = modelIntentionFor({ targetAllocation: raw1839, journalLines: journal1839, universe, reserveAsset: reserve, clamp, journalMandatory: true });
  ok('in the official window B̂\'s input is the journal', official?.source === 'journal_clamped');
  ok('and without the journal there, the cycle is refused rather than recomputed', modelIntentionFor({ targetAllocation: raw1839, journalLines: null, universe, reserveAsset: reserve, clamp, journalMandatory: true }) === null);
  ok('on the bench the clamp is recomputed, and says so', modelIntentionFor({ targetAllocation: raw1839, journalLines: null, universe, reserveAsset: reserve, clamp, journalMandatory: false })?.source === 'clamp_recomputed');

  // (b) THE CORRECTION, through the real functions, on each input.
  const correctWith = (target: Record<string, number>): CorrectionOutcome => {
    const assess: AssessBandInput = {
      policyVersion: config.exposureBand.version,
      policy: config.exposureBand,
      state: 'constructive',
      targetAllocation: target,
      rawAllocation: raw1839,
      bookExposurePercent: book1839.deployedPercent.toNumber(),
      reserveAsset: reserve,
      gateByAsset: gates1839,
      capOf,
      maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
      equityQuote: equity,
      movementFloorQuote: (equity * config.execution.minMovementPercent) / 100,
      stoppedWeightSurvives: false,
    };
    const input: CorrectInput = {
      assessment: assessBand(assess),
      clampedAllocation: target,
      rawAllocation: raw1839,
      reserveAsset: reserve,
      portfolio: book1839,
      priceOf: priceOf1839,
      feePercent: config.execution.feePercent,
      minMovementPercent: config.execution.minMovementPercent,
    };
    return correctToBand(input);
  };
  const right = correctWith(official!.allocation);
  const wrong = correctWith(applied1839);
  ok('[intention] the band raises the book to its floor', right.label === 'hausse_vers_plancher' && right.correctedExposurePercent === 45);
  const legsRight = attributeLegs(right.movements, right.lines);
  ok('BNB and ETH are the BAND\'s legs — allocation_de_secours, the model never asked for them', ['BNB', 'ETH'].every((a) => legsRight.find((l) => l.asset === a)?.origin === 'allocation_de_secours'));
  ok('each sized at the production journal\'s planned notional, to the cent', ['BNB', 'ETH'].every((a) => near(legsRight.find((l) => l.asset === a)!.notionalQuote, 164.18, 0.01)));
  ok('and XRP, held at the model\'s target, gets no leg', !legsRight.some((l) => l.asset === 'XRP'));
  ok('[applied — the defect] the band finds nothing to correct', wrong.label === 'aucune_correction');
  const legsWrong = attributeLegs(wrong.movements, wrong.lines);
  ok('and BNB and ETH become the MODEL\'s legs', ['BNB', 'ETH'].every((a) => legsWrong.find((l) => l.asset === a)?.origin === 'modele'));

  // (c) THE ATTRIBUTION FOLLOWS THE JOURNAL'S OWN CONVENTION: band ⇔ the band moved the line.
  ok('a leg on a line with correction_points = 0 is the model\'s, whatever its origin field says', attributeLegs(right.movements, right.lines.map((l) => ({ ...l, correctionPoints: 0 }))).every((l) => l.origin === 'modele'));
  ok('and with no correction at all (a stop cycle) every leg is the model\'s', attributeLegs(right.movements, null).every((l) => l.origin === 'modele'));

  // (d) THE REAL JOURNAL keeps planned and executed apart, and names why a planned leg did not
  // book — the journaled causes first, in order, and the inference last.
  const unbooked1926: JournalCorrectionLine = { ...journal1839[0]!, decisionId: 1926, asset: 'BTC', origin: 'correction_de_bande', correctionPoints: -1.25, correctedWeightPercent: 8.75, plannedSide: 'sell', plannedNotionalQuote: 21.56, bookedSide: null, bookedNotionalQuote: null };
  type Facts = { gateRefusal: string | null; pilotHold: string | null; correctionAllowed: boolean };
  const noFacts = (): Facts => ({ gateRefusal: null, pilotHold: null, correctionAllowed: true });
  // The cause of the one wanted leg, whichever bucket it lands in (planned-not-executed, or
  // suppressed by the corrector).
  const causeWith = (refused: string | null, facts: Facts, suppressed: string | null = null): string =>
    realBandLegs([{ ...unbooked1926, suppressedReason: suppressed }], 1839, 2000, () => refused, () => facts).wanted[0]!.notExecutedBecause ?? '';
  const real = realBandLegs([...journal1839, unbooked1926], 1839, 2000, () => null, noFacts);
  ok('two executed legs at 1839, one planned-not-executed at 1926', real.executed.length === 2 && real.plannedNotExecuted.length === 1 && real.planned.length === 3);
  ok('with nothing journaled, the unbooked leg names an INFERENCE, in those words', /déduit/.test(real.plannedNotExecuted[0]!.notExecutedBecause ?? ''));
  ok('an executor refusal, when journaled, is named instead', /refusée par l’exécuteur \(rejected: crumb\)/.test(causeWith('rejected: crumb', noFacts())));
  ok('a gate that refused the vector is named before any inference', /la porte a refusé le vecteur entier \(frozen leg/.test(causeWith('rejected: crumb', { gateRefusal: 'frozen leg BTC', pilotHold: null, correctionAllowed: true })));
  ok('a pilot hold is named before the gate — the correction never reached it', /pilot_hold prix_de_repli/.test(causeWith(null, { gateRefusal: 'frozen leg BTC', pilotHold: 'prix_de_repli', correctionAllowed: false })));
  ok('and the corrector\'s own suppression before everything', /supprimée par le correcteur \(movement_floor\)/.test(causeWith('rejected: crumb', { gateRefusal: 'x', pilotHold: 'y', correctionAllowed: false }, 'movement_floor')));
  // THIRD REVIEW ROUND. A leg the corrector's own floor deleted has NO planned side — only a
  // suppression — and it is a planned-not-executed leg all the same, with its side derived
  // from the correction and its notional from the suppressed one.
  const suppressedOnly = realBandLegs([{ ...unbooked1926, plannedSide: null, plannedNotionalQuote: null, suppressedReason: 'movement_floor', suppressedNotionalQuote: 19.8 }], 1839, 2000, () => null, noFacts);
  ok('a corrector-suppressed band leg is kept — WANTED by the band, suppressed before any plan, never counted as planned', suppressedOnly.wanted.length === 1 && suppressedOnly.suppressedByCorrector.length === 1 && suppressedOnly.planned.length === 0 && suppressedOnly.plannedNotExecuted.length === 0 && suppressedOnly.suppressedByCorrector[0]!.plannedSide === 'sell' && suppressedOnly.suppressedByCorrector[0]!.plannedNotionalQuote === 19.8 && /movement_floor/.test(suppressedOnly.suppressedByCorrector[0]!.notExecutedBecause ?? ''));
  // And a booking on a cycle where the correction was HELD is the model's, never the band's.
  const heldBooking = realBandLegs([{ ...unbooked1926, bookedSide: 'sell', bookedNotionalQuote: 21.5 }], 1839, 2000, () => null, () => ({ gateRefusal: null, pilotHold: 'prix_de_repli', correctionAllowed: false }));
  ok('a booking on a held cycle is not an executed band leg, and the cause says whose booking it was', heldBooking.executed.length === 0 && heldBooking.plannedNotExecuted.length === 1 && /le booking sell est celui du modèle/.test(heldBooking.plannedNotExecuted[0]!.notExecutedBecause ?? ''));
  const observationBooking = realBandLegs([{ ...unbooked1926, bookedSide: 'sell', bookedNotionalQuote: 21.5 }], 1839, 2000, () => null, () => ({ gateRefusal: null, pilotHold: null, correctionAllowed: false }));
  ok('and so is one made in observation mode', observationBooking.executed.length === 0 && /mode observation/.test(observationBooking.plannedNotExecuted[0]!.notExecutedBecause ?? ''));
}

// ── PROOF 13 — W4, W5 and W6 can really fail, and never pass on nothing ─────────────
console.log('\nProof 13 — the three criteria have a population, and each one can fail:');
{
  const legs = (...items: Array<[string, 'buy' | 'sell', 'modele' | 'correction_de_bande' | 'allocation_de_secours', number]>) =>
    items.map(([asset, side, origin, points]) => ({ asset, side, notionalQuote: 100, origin, correctionPoints: points }));
  const lineOf = (asset: string, over: Partial<CorrectionOutcome['lines'][number]> = {}) =>
    ({
      asset,
      rawWeightPercent: 0,
      clampedWeightPercent: 0,
      baseWeightPercent: 0,
      correctionPoints: 0,
      correctedWeightPercent: 0,
      origin: 'modele',
      cause: 'aucune',
      capPercent: 20,
      mayIncrease: true,
      mayDecrease: true,
      bookWeightPercent: 0,
      correctionMovesHolding: false,
      realisedWeightPercent: 0,
      ...over,
    }) as CorrectionOutcome['lines'][number];
  const intention = { allocation: { BNB: 0, USDT: 100 }, source: 'journal_clamped' as const };
  const cycle = (over: Partial<CounterfactualCycle>): CounterfactualCycle => ({
    decisionId: 1,
    followedRealBot: false,
    lines: [lineOf('BNB', { correctionPoints: 15, correctedWeightPercent: 15, origin: 'allocation_de_secours' }), lineOf('XRP', { mayIncrease: false, mayDecrease: false, cause: 'gel' })],
    legs: legs(['BNB', 'buy', 'allocation_de_secours', 15]),
    intention,
    recomputedClamp: { BNB: 0, USDT: 100 },
    ...over,
  });
  const universe = ['BNB', 'XRP'];

  // W4
  ok('[W4] a frozen line beside a band move is a population of one, and it passes clean', judgeW4({ cycles: [cycle({})], journal: [] }).status === 'pass');
  ok('[W4] no frozen line anywhere → NON MESURABLE, not pass', judgeW4({ cycles: [cycle({ lines: [lineOf('BNB', { correctionPoints: 15, origin: 'allocation_de_secours' })] })], journal: [] }).status === 'non_mesurable');
  ok('[W4] a band leg on the frozen line FAILS', judgeW4({ cycles: [cycle({ legs: legs(['XRP', 'buy', 'correction_de_bande', 5]) })], journal: [] }).status === 'fail');
  ok('[W4] a model leg on the frozen line is not a violation', judgeW4({ cycles: [cycle({ legs: legs(['XRP', 'buy', 'modele', 0]) })], journal: [] }).status === 'pass');
  const frozenJournal: JournalCorrectionLine = { decisionId: 1, asset: 'XRP', origin: 'correction_de_bande', cause: 'gel', rawWeightPercent: 0, clampedWeightPercent: 0, baseWeightPercent: 0, correctionPoints: 3, correctedWeightPercent: 3, plannedSide: 'buy', plannedNotionalQuote: 30, suppressedReason: null, suppressedNotionalQuote: null, bookedSide: null, bookedNotionalQuote: null, postCycleWeightPercent: 0, correctionMovesHolding: true };
  ok('[W4] the real journal moving a frozen line FAILS it too', judgeW4({ cycles: [cycle({})], journal: [frozenJournal] }).status === 'fail');

  // W5
  const base = { universe, reserveAsset: 'USDT', official: true, reference: null };
  ok('[W5] a band leg, attributed to its moved line: pass', judgeW5({ ...base, cycles: [cycle({})] }).status === 'pass');
  ok('[W5] no band leg over the window → NON MESURABLE', judgeW5({ ...base, cycles: [cycle({ legs: legs(['BNB', 'buy', 'modele', 0]), lines: [lineOf('BNB')] })] }).status === 'non_mesurable');
  ok('[W5] a leg attributed to the model on a line the band moved FAILS', judgeW5({ ...base, cycles: [cycle({ legs: legs(['BNB', 'buy', 'modele', 15]) })] }).status === 'fail');
  ok('[W5] an official window fed by a recomputation FAILS', judgeW5({ ...base, cycles: [cycle({ intention: { ...intention, source: 'clamp_recomputed' } })] }).status === 'fail');
  ok('[W5] a recomputed clamp that disagrees with the journal FAILS', judgeW5({ ...base, cycles: [cycle({ recomputedClamp: { BNB: 5, USDT: 95 } })] }).status === 'fail');
  ok('[W5] the reference cycle attributing a band asset to the model FAILS', judgeW5({ ...base, reference: { decisionId: 1, bandAssets: ['BNB'], untouchedAssets: ['XRP'] }, cycles: [cycle({ legs: legs(['BNB', 'buy', 'modele', 15]) })] }).status === 'fail');
  ok('[W5] the reference cycle touching the untouched asset FAILS', judgeW5({ ...base, reference: { decisionId: 1, bandAssets: ['BNB'], untouchedAssets: ['XRP'] }, cycles: [cycle({ legs: legs(['BNB', 'buy', 'allocation_de_secours', 15], ['XRP', 'buy', 'modele', 0]) })] }).status === 'fail');
  ok('[W5] and the reference as expected passes', judgeW5({ ...base, reference: { decisionId: 1, bandAssets: ['BNB'], untouchedAssets: ['XRP'] }, cycles: [cycle({})] }).status === 'pass');

  // W6
  const decisions: DecisionSummary[] = [
    { id: 1, status: 'decided', targetAllocation: { BNB: 0, USDT: 100 } },
    { id: 2, status: 'decided', targetAllocation: { BNB: 15, USDT: 85 } },
  ];
  const episode: AdoptionEpisode = { decisionId: 1, asset: 'BNB', origin: 'allocation_de_secours', direction: 'hausse', modelWeightPercent: 0, clampedWeightPercent: 0, imposedWeightPercent: 15, realisedWeightPercent: 15.2, bookedSide: 'buy', bookedNotionalQuote: 163, reaction: { decisionId: 2, modelWeightPercent: 15 }, skippedCycles: [], reading: 'maintien', because: null };
  const judge = (episodes: AdoptionEpisode[], over: Partial<Parameters<typeof judgeC8>[0]> = {}) =>
    judgeC8({ episodes, decisions, fromDecisionId: 1, toDecisionId: 2, windowClosed: false, claimsOfficial: false, ...over });
  ok('[W6] one consistent episode on an open window: pass, not official', judge([episode]).status === 'pass' && judge([episode]).official === false);
  ok('[W6] no episode → NON MESURABLE', judge([]).status === 'non_mesurable');
  ok('[W6] a reading that contradicts its own numbers FAILS', judge([{ ...episode, reading: 'repetition' }]).status === 'fail');
  ok('[W6] a reaction read on a cycle that is not the first decided one FAILS', judge([{ ...episode, reaction: { decisionId: 3, modelWeightPercent: 15 } }]).status === 'fail');
  ok('[W6] an episode without a booked leg FAILS', judge([{ ...episode, bookedSide: null as unknown as 'buy' }]).status === 'fail');
  ok('[W6] an official claim on an OPEN window FAILS', judge([episode], { claimsOfficial: true }).status === 'fail');
  ok('[W6] the same claim on a closed window is the official result', judge([episode], { windowClosed: true, claimsOfficial: true }).official === true);
  // A POPULATION OF UNREADABLE EPISODES MEASURES NOTHING (second review round): at closure, an
  // executed leg with no decided cycle after it is `non_mesurable`, and it must not turn into
  // an official C8 on the strength of existing.
  const unreadable: AdoptionEpisode = { ...episode, decisionId: 2, reaction: null, reading: 'non_mesurable', because: 'aucun cycle décidé ne suit' };
  ok('[W6] only unreadable episodes → NON MESURABLE, and nothing official even at closure', judge([unreadable], { windowClosed: true, claimsOfficial: false }).status === 'non_mesurable' && judge([unreadable], { windowClosed: true, claimsOfficial: false }).official === false);
}

// ── PROOF 13b — the settled point of the band layer, and the mode-aware stop ───────────
//
// SECOND REVIEW ROUND. Production writes the verdicts, THEN the band observation, THEN the
// corrections rows: a cutoff proven on the gates does not prove the corrections journal B̂ now
// reads. And a `stop_exit` verdict only takes a line under `enforce` — under `observe` the gate
// is a no-op and B̂ must correct as on any other cycle.
console.log('\nProof 13b — the corrections journal has its own settled point, and a stop only acts under enforce:');
{
  const obs = (entries: Array<[number, boolean]>) => new Map(entries.map(([id, computed]) => [id, { correctionComputed: computed }]));
  const expected = [100, 101, 102];
  ok('a cycle whose correction rows are all there is settled', bandSettledCutoff([100], obs([[100, true]]), new Map([[100, 4]]), 4) === 100);
  ok('a cycle still writing its corrections is NOT — the point stays on the previous cycle', bandSettledCutoff([100, 101], obs([[100, true], [101, true]]), new Map([[100, 4], [101, 2]]), 4) === 100);
  // FOURTH REVIEW ROUND: a complete cycle AFTER an incomplete one never carries the point past
  // the hole. 100 complete, 101 incomplete, 102 complete → 100.
  ok('[100 complet, 101 incomplet, 102 complet] the point stops at 100', bandSettledCutoff(expected, obs([[100, true], [101, true], [102, true]]), new Map([[100, 4], [101, 2], [102, 4]]), 4) === 100);
  ok('whatever order the rows arrive in', bandSettledCutoff([102, 100, 101], obs([[102, true], [100, true], [101, true]]), new Map([[100, 4], [101, 2], [102, 4]]), 4) === 100);
  ok('and an incomplete FIRST cycle settles nothing at all', bandSettledCutoff([100, 101], obs([[100, true], [101, true]]), new Map([[100, 1], [101, 4]]), 4) === null);
  ok('a cycle that computed no correction owes no rows', bandSettledCutoff([100, 101], obs([[100, true], [101, false]]), new Map([[100, 4]]), 4) === 101);
  ok('and with no complete cycle at all the answer is a refusal, not zero', bandSettledCutoff([100], obs([[100, true]]), new Map(), 4) === null && bandSettledCutoff([], new Map(), new Map(), 4) === null);
  // FIFTH REVIEW ROUND: the point is walked on the cycles EXPECTED, so a MISSING observation
  // row stops it — a scan over the rows present could not see the absence.
  ok('[obs 100 et 102 complètes, 101 absente] the point stops at 100', bandSettledCutoff(expected, obs([[100, true], [102, true]]), new Map([[100, 4], [102, 4]]), 4) === 100);
  ok('the first expected observation missing settles nothing', bandSettledCutoff(expected, obs([[101, true], [102, true]]), new Map([[101, 4], [102, 4]]), 4) === null);
  ok('and the answer does not depend on the order the data arrives in', bandSettledCutoff([102, 101, 100], obs([[102, true], [100, true]]), new Map([[102, 4], [100, 4]]), 4) === 100 && bandSettledCutoff([101, 102, 100], obs([[102, true], [101, true]]), new Map([[102, 4], [101, 4]]), 4) === null);
  ok('a complete observation later never carries the point past the hole', bandSettledCutoff([100, 101, 102, 103], obs([[100, true], [102, true], [103, true]]), new Map([[100, 4], [102, 4], [103, 4]]), 4) === 100);
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8').replace(/\r\n/g, '\n');
  ok('the replay takes the smaller of the gate point and the band point', /const cutoffId = Math\.min\(gateCutoffId, bandCutoffId\);/.test(replay));
  ok('and walks the band point on the DECISIONS expected since the journal began, not on the rows present', /allDecisionSummaries\.map\(\(d\) => d\.id\)\.filter\(\(id\) => id >= firstJournaledId\)/.test(replay) && /bandSettledCutoff\(\s*\n\s*expectedBandCycles,/.test(replay));
  ok('and refuses when the band layer is settled nowhere', /no cycle carries a complete band closure/.test(replay));
  ok('the corrections journal is read below the final bound only', /const correctionsByDecision = new Map\(\[\.\.\.bandRowsByDecision\]\.filter\(\(\[id\]\) => id <= upperBound\)\);/.test(replay));
  ok('B̂ follows the real bot on a stop cycle under `enforce`, never under `observe`', /transitionMode === 'enforce' \|\|/.test(replay) && /transitionMode == null &&/.test(replay) && /\(cycle\.applied\[asset\] \?\? 0\) === 0 && \(cycle\.raw\?\.\[asset\] \?\? 0\) > 0/.test(replay));
  ok('and C8 receives the frozen mode', /transitionMode: chainTransitionMode,\s*\n\s*correctionAllowed: \(id\) => cycleFacts\(id\)\.correctionAllowed,\s*\n\s*\}\);/.test(replay));
  // AN OFFICIAL WINDOW WITHOUT ITS FROZEN MODE IS A REFUSAL (third review round): the replay
  // would otherwise size B̂ as under `observe` and read C8 without the enforced gate, and call
  // the result the pilot's.
  ok('an official window without a frozen gate mode is refused, with its reason', /if \(pilotWindow\.official && pilotTransitionMode == null\) \{/.test(replay) && /ne porte pas de mode de porte fige/.test(replay));
  ok('the correction-allowed fact comes from the observation row — mode application and no hold', /correctionAllowed: row\.mode === 'application' && row\.pilot_hold == null,/.test(replay));
}

// ── PROOF 14 — the replay is wired to all of it, and no criterion is a constant ────────
console.log('\nProof 14 — the replay feeds B̂ the intention, judges through the judges, and keeps three things apart:');
{
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8').replace(/\r\n/g, '\n');
  ok('B̂ is fed `cycle.intention`, never `cycle.applied`, for its assessment and its correction', /targetAllocation: intention,/.test(replay) && /clampedAllocation: intention,/.test(replay) && !/clampedAllocation: cycle\.applied/.test(replay));
  ok('`applied` is only aimed at on a stop cycle, where B̂ follows the real bot', /allocation: correction == null \? cycle\.applied : correction\.correctedAllocation/.test(replay));
  ok('B̂ opens on the bot\'s real book, not in cash', /let bookB: WitnessBook = openBookFromRealBook\(cycles\[0\]!\.context\);/.test(replay));
  ok('the corrections journal is loaded up to the gate-settled point, then bounded by the final one', /loadCorrectionsJournal\(supabase, gateCutoffId\)/.test(replay) && /filter\(\(\[id\]\) => id <= upperBound\)/.test(replay));
  ok('and it is mandatory in the official window', /journalMandatory: pilotWindow\.official,/.test(replay) && /'no_corrections_journal'/.test(replay));
  ok('every leg is attributed through `attributeLegs`', /attributeLegs\(stepB\.movements, correction\?\.lines \?\? null\)/.test(replay));
  ok('no criterion is recorded on a constant any more', !/record\('W[0-9b]+', '[^']*', (true|false),/.test(replay));
  ok('W4, W5 and W6 are recorded on their judges\' status', ['W4', 'W5', 'W6'].every((id) => new RegExp(`record\\('${id}', '[^']*', verdict\\.status,`).test(replay)));
  ok('a criterion has three outcomes and NON MESURABLE is printed as such', /'NON MESURABLE'/.test(replay) && /non_mesurable/.test(replay));
  ok('only a failure exits non-zero; a non-measurable does not pass for green', /results\.filter\(\(r\) => r\.status === 'fail'\)/.test(replay) && /non mesurable\(s\)/.test(replay));
  ok('the report separates the real journal, the counterfactual and C8', /FAITS RÉELS/.test(replay) && /real_journal:/.test(replay) && /counterfactual:/.test(replay) && /c8: c8Artefact/.test(replay));
  ok('and the artefact says C8 is descriptive until the closure', /descriptif tant que la fenêtre de mesure/.test(replay));
  // FINALITY FOLLOWS THE RESOLVED INSTANT. A closed pilot replayed at `--at=alerte_40` is a
  // snapshot cut before the closure; its C8 must stay descriptive (first review round).
  ok('C8 is official only when the window was resolved on the `cloture` instant, never on the pilot row alone', /const closedAtSelectedInstant = pilotWindow\.official && pilotWindow\.instant === 'cloture';/.test(replay) && /windowClosed: closedAtSelectedInstant,/.test(replay) && !/windowClosed: pilotWindow\.official && windowClosed,/.test(replay));
  ok('and a planned leg\'s cause reads the gate refusal and the pilot hold before inferring', /gateRefusal: divergenceOf\.get\(id\) \?\? null,\s*\n\s*pilotHold: marker\?\.pilotHold \?\? null,\s*\n\s*correctionAllowed: marker\?\.correctionAllowed \?\? false,/.test(replay));
  ok('the reference cycle 1839 is asserted whenever it is in the window', /decisionId: 1839, bandAssets: \['BNB', 'ETH'\], untouchedAssets: \['XRP'\]/.test(replay));
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** The transitive RUNTIME module graph — `import type` edges are erased, deliberately. */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const runtime = source.replace(/^import\s+type\s[\s\S]*?from\s+'[^']+';/gm, '');
    for (const match of runtime.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

console.log(`\nAll ${passed} exposure-witness proofs passed.`);
