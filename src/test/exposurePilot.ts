import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config, resolveExposureBandMode } from '../config/index.js';
import {
  contractDigest,
  judgePilot,
  judgeWindowClosure,
  pilotContractOf,
  type PilotIdentity,
  type PilotJudgeInput,
} from '../exposure/pilot.js';

/**
 * THE PROOFS OF THE PILOT'S IDENTITY AND ITS CIRCUIT BREAKER — brick 4.
 *
 * No network, no database, no clock, no LLM. The whole lifecycle is a pure function, which is
 * why a drawdown that would take weeks to happen can be walked here in nine lines.
 *
 * Two of these are §6 requirements verbatim: that the drawdown and the identity SURVIVE A
 * RESTART, and that the circuit breaker is proven on a SIMULATED DRAWDOWN rather than merely
 * read in the source.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();
const CONTRACT = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP']);
const SHA = contractDigest(CONTRACT);
const DRAWDOWN = {
  alertPercent: config.exposurePilot.alertDrawdownPercent,
  stopPercent: config.exposurePilot.stopDrawdownPercent,
};

function identity(over: Partial<PilotIdentity> = {}): PilotIdentity {
  return {
    contractSha256: SHA,
    contractVersion: config.exposurePilot.contractVersion,
    status: 'active',
    activatedAt: '2026-09-06T00:00:00.000Z',
    activatedDecisionId: 1000,
    openingEquityQuote: 1000,
    peakEquityQuote: 1000,
    alertDrawdownAt: null,
    lastSeenDecisionId: 1000,
    ...over,
  };
}

function judge(over: Partial<PilotJudgeInput> = {}) {
  return judgePilot({
    mode: 'application',
    identity: identity(),
    identityReadFailed: false,
    contractSha256: SHA,
    contractVersion: config.exposurePilot.contractVersion,
    equityQuote: 1000,
    drawdown: DRAWDOWN,
    // The journal's newest decided cycle IS the one the pilot last saw: no hole.
    latestDecidedDecisionId: 1000,
    ...over,
  });
}

// ── PROOF 1 — legal is not armed ─────────────────────────────────────────────────────
console.log('Proof 1 — `application` is a legal value, and that alone arms nothing:');
{
  ok('the resolver now accepts it', resolveExposureBandMode('application') === 'application');
  ok('and still accepts the other two', resolveExposureBandMode('observation') === 'observation' && resolveExposureBandMode('off') === 'off');
  ok('absence still means off', resolveExposureBandMode(undefined) === 'off');
  for (const bad of ['Application', 'APPLICATION', 'enforce', 'on', '1']) {
    let refused = false;
    try {
      resolveExposureBandMode(bad);
    } catch {
      refused = true;
    }
    ok(`"${bad}" is still refused rather than defaulted`, refused);
  }

  // THE SECOND LOCK. Whatever the variable says, the correction needs the pilot's own verdict.
  ok('in observation the pilot holds, whatever else is true', judge({ mode: 'observation' }).hold === 'mode_inactif');
  ok('and in off too', judge({ mode: 'off' }).hold === 'mode_inactif');
  ok('neither computes a drawdown it has no business computing', judge({ mode: 'observation' }).drawdownPercent === null);
}

// ── PROOF 2 — the official instant is spent exactly once ─────────────────────────────
console.log('\nProof 2 — activation happens once, and everything starts there:');
{
  const first = judge({ identity: null, equityQuote: 1234.5 });
  ok('with no pilot yet, the first application cycle activates', first.write?.kind === 'activation');
  ok('the opening equity is this cycle\'s equity', first.write?.kind === 'activation' && first.write.openingEquityQuote === 1234.5);
  ok('the high-water mark opens at the same number', first.write?.kind === 'activation' && first.write.peakEquityQuote === 1234.5);
  ok('the drawdown is zero by construction, not by luck', first.drawdownPercent === 0);
  ok('and the correction applies from that very cycle — the initial alignment counts', first.mayCorrect);

  // The SECOND cycle finds a pilot and never activates again. The database enforces the same
  // rule with a singleton index; this is the layer above it.
  const second = judge({ identity: identity({ openingEquityQuote: 1234.5, peakEquityQuote: 1234.5 }), equityQuote: 1234.5 });
  ok('the next cycle does not activate a second time', second.write === null || second.write.kind !== 'activation');
  const migration = readFileSync(path.join(ROOT, 'supabase/migrations/0033_exposure_pilot.sql'), 'utf8').replace(/\r\n/g, '\n');
  ok(
    'and the database refuses a second identity outright',
    /create unique index if not exists exposure_pilot_singleton/.test(migration),
  );
  ok(
    'no code path builds a following pilot — that stays an administrative act',
    !/insert\(\{[\s\S]{0,400}status: 'active'[\s\S]{0,200}\}\)/.test(
      readFileSync(path.join(ROOT, 'src/exposure/pilot.ts'), 'utf8'),
    ),
  );
}

// ── PROOF 3 — the circuit breaker, walked on a SIMULATED drawdown ────────────────────
//
// §6 asks for this one explicitly: proven on a scenario, not merely read. The equity walks
// down from a peak of 1000 and every rung is checked on the way.
console.log('\nProof 3 — the breaker on a simulated drawdown, rung by rung:');
{
  const peak = identity({ peakEquityQuote: 1000, openingEquityQuote: 1000 });

  const calm = judge({ identity: peak, equityQuote: 900 });
  ok('[10%] nothing fires, and the correction keeps applying', calm.mayCorrect && calm.alert === null);
  ok('the drawdown is measured from the PEAK, not from the opening', Math.abs((calm.drawdownPercent ?? 0) - 10) < 1e-9);

  const nearly = judge({ identity: peak, equityQuote: 601 });
  ok('[39.9%] still nothing — the threshold is not "about 40"', nearly.alert === null && nearly.mayCorrect);

  const warned = judge({ identity: peak, equityQuote: 600 });
  ok('[40%] the alert fires', warned.alert === 'drawdown_40');
  ok('it is latched durably before it is sent', warned.write?.kind === 'alert_drawdown');
  ok('AND THE CORRECTION KEEPS APPLYING — this rung is a warning, not a stop', warned.mayCorrect);

  const already = judge({ identity: identity({ peakEquityQuote: 1000, alertDrawdownAt: '2026-09-06T04:00:00.000Z' }), equityQuote: 550 });
  ok('[45%, already warned] the alert does NOT fire twice', already.alert === null);
  ok('and the correction is still applying', already.mayCorrect);

  const stopped = judge({ identity: peak, equityQuote: 500 });
  ok('[50%] the circuit breaker trips', stopped.alert === 'drawdown_50');
  ok('the band correction stops', !stopped.mayCorrect && stopped.hold === 'pilote_arrete_drawdown');
  ok('the stop is persisted before anything else happens', stopped.write?.kind === 'stop_drawdown');
  ok('and the status becomes terminal', stopped.statusAfter === 'stopped_drawdown');

  // WHAT IT DOES NOT DO. The judgement has no way to express a liquidation, a halt or a
  // strategy verdict — not because it declines to, but because the type has no such field.
  ok(
    'nothing in the verdict can liquidate, halt or judge the strategy',
    !('liquidate' in stopped) && !('halt' in stopped) && !('verdict' in stopped),
  );
  const source = readFileSync(path.join(ROOT, 'src/exposure/pilot.ts'), 'utf8');
  ok('and the module cannot place an order at all', !/executeMovements|placeOrder|computeMovements/.test(source));

  // NO AUTOMATIC RESURRECTION. A restart, a variable, a recovery in equity: none of them
  // brings a stopped pilot back.
  const afterStop = identity({ status: 'stopped_drawdown', peakEquityQuote: 1000 });
  ok('a stopped pilot stays stopped when equity recovers', !judge({ identity: afterStop, equityQuote: 1000 }).mayCorrect);
  ok('and even at a NEW high', !judge({ identity: afterStop, equityQuote: 5000 }).mayCorrect);
  ok('with its reason named every time', judge({ identity: afterStop, equityQuote: 5000 }).hold === 'pilote_arrete_drawdown');
}

// ── PROOF 4 — the identity and the drawdown SURVIVE A RESTART ────────────────────────
//
// §6, verbatim. A restart is exactly this: the process is gone, the identity is read back from
// the database, and the pilot resumes on the numbers it left behind rather than on fresh ones.
console.log('\nProof 4 — a restart changes nothing the pilot knows:');
{
  const beforeRestart = identity({ openingEquityQuote: 1000, peakEquityQuote: 1800 });
  const after = judge({ identity: beforeRestart, equityQuote: 1100 });
  ok(
    'the drawdown is measured from the PERSISTED peak, not from the equity at boot',
    Math.abs((after.drawdownPercent ?? 0) - ((1800 - 1100) / 1800) * 100) < 1e-9,
  );
  ok('a fresh process does not reset the peak', after.peakEquityQuote === 1800);
  ok('and does not re-activate anything', after.write === null || after.write.kind === 'peak');

  // THE FAILURE THIS PREVENTS. A peak that reset to the equity at boot would report a drawdown
  // of zero on the day after the worst day of the pilot.
  const naive = ((1100 - 1100) / 1100) * 100;
  ok('a reset peak would have reported 0% on that same cycle', naive === 0 && (after.drawdownPercent ?? 0) > 38);

  // A peak only ever rises, including across a restart that happened at a high.
  ok('a new high raises it', judge({ identity: beforeRestart, equityQuote: 2000 }).peakEquityQuote === 2000);
  ok('and a low never lowers it', judge({ identity: beforeRestart, equityQuote: 10 }).peakEquityQuote === 1800);
}

// ── PROOF 5 — the contract, and what invalidates a pilot ─────────────────────────────
console.log('\nProof 5 — the contract digest, and the divergence that ends a pilot:');
{
  ok('the same contract gives the same digest', contractDigest(CONTRACT) === contractDigest(CONTRACT));
  ok(
    'the order the caller built its objects in does not matter',
    contractDigest({ ...CONTRACT, universe: ['XRP', 'BNB', 'ETH', 'BTC'] }) === SHA,
  );
  const variants: Array<[string, typeof CONTRACT]> = [
    ['a moved bound', { ...CONTRACT, band: { ...CONTRACT.band, neutral: { lowPercent: 21, highPercent: 45 } } }],
    ['a changed cap', { ...CONTRACT, caps: { ...CONTRACT.caps, perAsset: { ...CONTRACT.caps.perAsset, XRP: 16 } } }],
    ['a changed fee', { ...CONTRACT, execution: { ...CONTRACT.execution, feePercent: 0.2 } }],
    ['a changed threshold', { ...CONTRACT, drawdown: { alertPercent: 35, stopPercent: 50 } }],
    ['a changed window', { ...CONTRACT, window: { ...CONTRACT.window, requiredBarsPerFamily: 80 } }],
    ['a changed universe', { ...CONTRACT, universe: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL'] }],
    ['a moved contract version', { ...CONTRACT, contractVersion: 'A.2' }],
  ];
  for (const [what, variant] of variants) {
    ok(`${what} changes the digest`, contractDigest(variant) !== SHA);
  }
  ok(
    'the git SHA is NOT in it — a comment must not kill an eight-week experiment',
    !/execFileSync|child_process|getGitSha|GIT_COMMIT|COMMIT_SHA/.test(codeOf('src/exposure/pilot.ts')),
  );

  const diverged = judge({ identity: identity({ contractSha256: 'autre' }), equityQuote: 1000 });
  ok('[divergence] the correction stops', !diverged.mayCorrect && diverged.hold === 'contrat_divergent');
  ok('the pilot is invalidated durably', diverged.write?.kind === 'invalidate_contract' && diverged.statusAfter === 'invalidated_contract');
  ok('and it alerts once', diverged.alert === 'contract_invalidated');
  ok(
    'the contract is judged BEFORE any drawdown — thresholds we no longer recognise are not thresholds',
    judge({ identity: identity({ contractSha256: 'autre', peakEquityQuote: 1000 }), equityQuote: 400 }).alert ===
      'contract_invalidated',
  );
  const restored = identity({ status: 'invalidated_contract' });
  ok('going back to the old configuration does not revive it', !judge({ identity: restored }).mayCorrect);
}

// ── PROOF 6 — every doubt fails closed ───────────────────────────────────────────────
console.log('\nProof 6 — an unreadable identity, an unusable equity: the band stands down:');
{
  ok('an unreadable identity holds the correction', !judge({ identityReadFailed: true }).mayCorrect);
  ok('and names why', judge({ identityReadFailed: true }).hold === 'identite_illisible');
  ok(
    'a failed read is NOT read as "no pilot yet" — that would activate a second one',
    judge({ identityReadFailed: true, identity: null }).write === null,
  );
  for (const equity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    ok(`an equity of ${String(equity)} holds the correction`, judge({ equityQuote: equity }).hold === 'equite_inutilisable');
  }
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    'a mandatory write that does not land disarms the correction for the cycle',
    /mayCorrect = false;\s*\n\s*pilotHold = 'ecriture_obligatoire_impossible';/.test(decide),
  );
  ok(
    'and the corrected target defaults to the model\'s own bounded proposal',
    /let correctedAllocation = clamp\.applied;/.test(decide) && /let correctedMovements = proposedMovements;/.test(decide),
  );
  ok(
    'the identity is only read in `application` — observation adds no query to the cycle',
    /EXPOSURE_BAND_MODE === 'application' \? await readPilotIdentity\(supabase\) : null/.test(decide),
  );
  ok('the hold is journaled per cycle, not merely logged', /row\.pilot_hold = opts\.pilot\.hold;/.test(decide));
}

// ── PROOF 7 — the measurement window closes; the band does not ───────────────────────
console.log('\nProof 7 — the clock closes the window, never the application:');
{
  const at = (weeks: number): Date => new Date(Date.parse('2026-09-06T00:00:00.000Z') + weeks * 7 * 24 * 3600 * 1000);
  const closure = (weeks: number, constructive: number, nonConstructive: number) =>
    judgeWindowClosure({
      activatedAt: '2026-09-06T00:00:00.000Z',
      now: at(weeks),
      minWeeks: config.exposurePilot.minWeeks,
      maxWeeks: config.exposurePilot.maxWeeks,
      requiredBarsPerFamily: config.exposurePilot.requiredBarsPerFamily,
      constructiveBars: constructive,
      nonConstructiveBars: nonConstructive,
    });

  ok('[4 semaines] nothing closes early, however good the coverage', !closure(4, 500, 500).closed);
  ok('[8 semaines, couverture atteinte] the window closes', closure(8, 84, 84).closed);
  ok('with the label that says so', closure(8, 84, 84).label === 'couverture_atteinte');
  ok('[8 semaines, une famille courte] it runs on', !closure(8, 84, 83).closed);
  ok('[10 semaines] still running, still short', !closure(10, 200, 83).closed);
  ok('[12 semaines] it closes whatever happens', closure(12, 200, 83).closed);
  ok('and says the coverage was insufficient', closure(12, 200, 83).label === 'couverture_de_contexte_insuffisante');
  ok('[12 semaines, couverture atteinte] it closes on the good label', closure(12, 84, 84).label === 'couverture_atteinte');

  // THE ARBITRATION. Closing the measurement window does not disarm the correction: rearranging
  // a portfolio on a calendar date, for a reason that has nothing to do with risk, is exactly
  // what this separation avoids.
  const verdict = closure(12, 1, 1);
  ok(
    'a closure carries no power to stop the correction',
    !('mayCorrect' in verdict) && !('stop' in verdict) && !('status' in verdict),
  );
  const pilot = readFileSync(path.join(ROOT, 'src/exposure/pilot.ts'), 'utf8');
  ok(
    'and the module says so where someone will read it',
    /closes the MEASUREMENT\s*\n \* WINDOW, not the application of the band/.test(pilot),
  );
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok(
    'the closure writer never touches `status`',
    /closeMeasurementWindow[\s\S]*?window_closure_label[\s\S]*?\}\)/.test(persistence) &&
      !/closeMeasurementWindow[\s\S]*?status:/.test(persistence),
  );
}

// ── PROOF 8 — the pilot cannot reach outside itself ──────────────────────────────────
console.log('\nProof 8 — the module on the trading path can neither spawn, read nor query:');
{
  const graph = moduleGraph(path.join(ROOT, 'src/exposure/pilot.ts'));
  ok(`the graph is ${graph.size} file(s) — itself and nothing else`, graph.size === 1);
  const code = codeOf('src/exposure/pilot.ts');
  ok('it imports node:crypto and nothing more', (code.match(/^import /gm) ?? []).length === 1);
  ok('no file system, no process', !/node:fs|node:child_process|readFileSync|execFileSync/.test(code));
  ok('no query builder', !/\.from\('/.test(code));
  ok('and no clock of its own — every instant is an argument', !/Date\.now\(\)|new Date\(\)/.test(code));
}

// ── PROOF 9 — an interrupted pilot never resumes ─────────────────────────────────────
//
// ARBITRATED, and it replaces a documented limitation with a refusal. The brick shipped with
// this hole: the high-water mark was only tracked while the pilot was armed, so a spell in
// `observation` could hide a peak, and every drawdown measured afterwards would be smaller
// than the truth — in the direction that makes the breaker bite too late.
//
// THE DETECTION IS FROM THE JOURNAL, NOT FROM A FLAG. A flag would have to be set by the very
// cycle that was not running this code. The decided cycles, on the other hand, are written
// whatever the mode: if one exists that is newer than the cycle the pilot last saw, the pilot
// missed it. That is what makes "no intermediate cycle can be ignored" a proof rather than a
// hope.
console.log('\nProof 9 — a cycle the pilot did not see ends it, and nothing brings it back:');
{
  // (a) A PLAIN RESTART, application unchanged. The decided cycles follow one another, so
  // there is no hole: the pilot resumes from its persisted state.
  const resumed = judge({
    identity: identity({ lastSeenDecisionId: 1500, peakEquityQuote: 1800 }),
    latestDecidedDecisionId: 1500,
    equityQuote: 1700,
  });
  ok('[redémarrage] the pilot resumes normally', resumed.mayCorrect && resumed.hold === null);
  ok('on the peak it left behind, not on the equity at boot', resumed.peakEquityQuote === 1800);
  ok('and nothing is invalidated', resumed.statusAfter === 'active');

  // (b) A SPELL IN OBSERVATION OR OFF. Cycles 1501..1504 were decided while the pilot was not
  // running; at 1505 the journal shows a decided cycle newer than the one it saw.
  const interrupted = judge({
    identity: identity({ lastSeenDecisionId: 1500, peakEquityQuote: 1800 }),
    latestDecidedDecisionId: 1504,
    equityQuote: 1700,
  });
  ok('[passage en observation] the interruption is detected', interrupted.hold === 'pilote_interrompu');
  ok('the correction stands down', !interrupted.mayCorrect);
  ok('the identity is invalidated durably', interrupted.statusAfter === 'interrupted_mode');
  ok(
    'and the write records BOTH ends of the hole',
    interrupted.write?.kind === 'interrupt_mode' &&
      interrupted.write.lastSeenDecisionId === 1500 &&
      interrupted.write.latestDecidedDecisionId === 1504,
  );
  ok('with an alert of its own', interrupted.alert === 'mode_interrupted');
  ok('a single missed cycle is enough — the rule has no tolerance', judge({
    identity: identity({ lastSeenDecisionId: 1500 }),
    latestDecidedDecisionId: 1501,
  }).hold === 'pilote_interrompu');

  // (c) THE VARIABLE COMES BACK. It does not re-arm anything, ever.
  const back = judge({ identity: identity({ status: 'interrupted_mode', lastSeenDecisionId: 1500 }), latestDecidedDecisionId: 1500 });
  ok('[retour à application] the correction is still refused', !back.mayCorrect);
  ok('with the same named cause', back.hold === 'pilote_interrompu');
  ok(
    'and a recovery to a new high changes nothing',
    !judge({ identity: identity({ status: 'interrupted_mode' }), equityQuote: 99999 }).mayCorrect,
  );

  // (d) THE INVARIANT THIS BUYS. A pilot that is STILL VALID has seen every decided cycle since
  // its activation, so no peak it could have observed is missing from its high-water mark.
  ok(
    'an identity that is still active has no unseen decided cycle behind it',
    judge({ identity: identity({ lastSeenDecisionId: 1500 }), latestDecidedDecisionId: 1500 }).statusAfter === 'active' &&
      judge({ identity: identity({ lastSeenDecisionId: 1500 }), latestDecidedDecisionId: 1501 }).statusAfter !== 'active',
  );
  ok(
    'so a missing peak can never understate a valid pilot\'s drawdown',
    judge({ identity: identity({ lastSeenDecisionId: 1500 }), latestDecidedDecisionId: 1502 }).mayCorrect === false,
  );

  // (e) THE CHECK CANNOT BE SKIPPED. A journal it could not read fails closed rather than
  // waving the cycle through.
  ok('an unreadable journal holds the correction', !judge({ latestDecidedDecisionId: null }).mayCorrect);
  ok('and is treated as an unreadable identity', judge({ latestDecidedDecisionId: null }).hold === 'identite_illisible');

  // (f) THE HEARTBEAT IS WRITTEN ON EVERY APPLICATION CYCLE, not only when something changed —
  // otherwise its absence would mean two different things.
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    'the mark is written on every application cycle with an active pilot',
    /EXPOSURE_BAND_MODE === 'application' && id != null && pilotJudgement\.statusAfter === 'active'[\s\S]{0,120}markPilotSawDecision\(supabase, id\)/.test(
      decide,
    ),
  );
  ok(
    'and the journal is read before the verdict, in application only',
    /EXPOSURE_BAND_MODE === 'application' \? await readLatestDecidedDecisionId\(supabase\) : null/.test(decide),
  );
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok(
    'only DECIDED cycles count — a skipped cycle decides nothing and moves no order',
    /readLatestDecidedDecisionId[\s\S]{0,600}?\.eq\('status', 'decided'\)/.test(persistence),
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * A file's CODE, with its prose removed.
 *
 * The pilot module's own header explains, at length, why it does NOT import
 * `node:child_process`. A proof that grepped the raw file would fail on that very sentence —
 * and the lesson generalises: a check that cannot tell an explanation from an instruction
 * proves nothing about either.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

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

console.log(`\nAll ${passed} exposure-pilot proofs passed.`);
