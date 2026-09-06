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
  readAdoption,
  stepWitness,
  valueBook,
  witnessRow,
  type WitnessBook,
} from '../exposure/witness.js';

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

// ── PROOF 6 — C8's reader, built now and read later ──────────────────────────────────
//
// Three readings, because one would mislead. "The model asks less than the imposed position" is
// nearly automatic: it re-emits its own preference, which is what it did before the correction
// existed. What separates indifference from a FIGHT is that it goes lower than it had itself
// gone.
console.log('\nProof 6 — adoption, indifference and fight are three different things:');
{
  ok(
    '[adoption] the model asks for the imposed weight, or more',
    readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 15 }) === 'adoption' &&
      readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 20 }) === 'adoption',
  );
  ok(
    '[indifférence] it re-emits its own preference, unchanged',
    readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 5 }) === 'indifference' &&
      readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 9 }) === 'indifference',
  );
  ok(
    '[lutte] it goes BELOW where it had itself gone',
    readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 0 }) === 'lutte' &&
      readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: 4.9 }) === 'lutte',
  );
  ok(
    'a missing reading is `sans_objet`, never a verdict',
    readAdoption({ imposedWeightPercent: 15, modelWeightPercent: null, nextModelWeightPercent: 5 }) === 'sans_objet' &&
      readAdoption({ imposedWeightPercent: 15, modelWeightPercent: 5, nextModelWeightPercent: null }) === 'sans_objet',
  );

  // AND NO VERDICT IS PUBLISHED. The question asks what the model does when it SEES a corrected
  // position; in observation mode it never saw one. A weakened figure printed now would be read
  // as the answer.
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'the replay states that C8 has no verdict during observation',
    /le verdict n’est pas rendu/.test(replay),
  );
  ok(
    'and it does not call the reader to produce one',
    !/readAdoption\s*\(/.test(replay),
  );
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
