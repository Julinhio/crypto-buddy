import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { dec } from '../money.js';
import type { PriceLookup } from '../portfolio/derive.js';
import {
  equalWeightUnderCaps,
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
