import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config, resolveExposureBandMode } from '../config/index.js';
import {
  contractDigest,
  journalPilotHold,
  judgePilot,
  judgeWindowClosure,
  pilotAlertMessage,
  pilotContractOf,
  resolvePilotWindow,
  valuationHold,
  type PilotAlert,
  type PilotIdentity,
  type PilotWindowRow,
  type PilotJudgeInput,
  type PilotWrite,
} from '../exposure/pilot.js';
import { resolvePilotEventCycles } from '../persistence/exposurePilot.js';
import type { SupabaseClient } from '@supabase/supabase-js';

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
const CONTRACT = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT', 'enforce');
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
    activationBaselineDecisionId: 999,
    windowClosedAt: null,
    transitionMode: 'enforce',
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
    // Every held line has a live price: the ordinary cycle, and the only kind the pilot saw
    // in its first 240 cycles.
    fallbackPricedAssets: [],
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
    /EXPOSURE_BAND_MODE === 'application' \? readPilotIdentity\(supabase\) : Promise\.resolve\(null\)/.test(decide),
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
    /EXPOSURE_BAND_MODE === 'application' \? readLatestDecidedDecisionId\(supabase\) : Promise\.resolve\(null\)/.test(decide),
  );
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok(
    'only DECIDED cycles count — a skipped cycle decides nothing and moves no order',
    /readLatestDecidedDecisionId[\s\S]{0,600}?\.eq\('status', 'decided'\)/.test(persistence),
  );
}

// ── PROOF 10 — four alerts, four messages, and none of them borrowed ────────────────
//
// THE DEFECT THIS REPLACES. The four alerts were worded by a chain of ternaries, whose LAST
// branch caught whatever nobody had written a case for. `mode_interrupted` fell into it and
// announced a contract divergence: an operator reading that alert would have gone looking for a
// configuration change that never happened, while the real event — a pilot that had lost sight
// of its own cycles — went unsaid.
console.log('\nProof 10 — each alert says what actually happened:');
{
  const facts = { drawdownPercent: 43.21, lastSeenDecisionId: 1500, latestDecidedDecisionId: 1504 };
  const message = (alert: PilotAlert): string => pilotAlertMessage(alert, facts);

  ok(
    '[40%] names the drawdown AND says the correction continues',
    message('drawdown_40').includes('43.21%') && /CONTINUE/.test(message('drawdown_40')),
  );
  ok(
    '[50%] names the breaker, the persistence and the absence of liquidation',
    /COUPE-CIRCUIT/.test(message('drawdown_50')) &&
      message('drawdown_50').includes('desarmee durablement') &&
      message('drawdown_50').includes('Aucune liquidation'),
  );
  ok(
    '[contrat] names the divergence and nothing else',
    message('contract_invalidated').includes('contrat a diverge') &&
      !message('contract_invalidated').includes('cycles decides'),
  );
  ok(
    '[interruption] names the missed cycles, both ends of the hole included',
    message('mode_interrupted').includes('cycles decides') &&
      message('mode_interrupted').includes('1500') &&
      message('mode_interrupted').includes('1504'),
  );
  ok(
    'it says the identity is invalidated DURABLY and the correction disarmed',
    message('mode_interrupted').includes('DURABLEMENT') &&
      message('mode_interrupted').includes('desarmee'),
  );
  ok(
    'and that putting the variable back will not revive it',
    message('mode_interrupted').includes('ne la reactivera pas'),
  );
  ok(
    'THE DEFECT ITSELF: the interruption no longer borrows the contract message',
    !message('mode_interrupted').includes('contrat a diverge'),
  );
  ok(
    'every alert says the v5 bot carries on, except the one where nothing stops',
    (['drawdown_50', 'contract_invalidated', 'mode_interrupted'] as PilotAlert[]).every((a) =>
      message(a).includes('bot v5 continue'),
    ),
  );
  const four: PilotAlert[] = ['drawdown_40', 'drawdown_50', 'contract_invalidated', 'mode_interrupted'];
  ok('the four messages are four DIFFERENT messages', new Set(four.map(message)).size === 4);
  ok('and none is empty', four.every((a) => message(a).length > 60));
  ok(
    'the call site no longer words them itself',
    !/Pilote d'exposition — drawdown \$\{drawdown\}/.test(
      readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8'),
    ),
  );
}

// ── PROOF 11 — an official window, or a named refusal — never a half-official run ───
//
// THE DEFECT THIS REPLACES. The mere existence of a pilot row made a run "official". An
// identity whose activation cycle had never been backfilled, or whose opening equity could not
// be read, would have printed FENÊTRE OFFICIELLE while replaying the whole history from a
// different equity — a bench run wearing the pilot's name.
console.log('\nProof 11 — the official window refuses on every doubt, and says why:');
{
  const row = (over: Partial<PilotWindowRow> = {}): PilotWindowRow => ({
    status: 'active',
    activatedAt: '2026-09-06T00:00:00.000Z',
    activatedDecisionId: 1500,
    openingEquityQuote: 1026.26,
    alertAt: null,
    stoppedAt: null,
    closedAt: null,
    alertDecisionId: null,
    stoppedDecisionId: null,
    closedDecisionId: null,
    ...over,
  });

  // (a) NO IDENTITY — a bench run, as before.
  const none = resolvePilotWindow(null, null);
  ok('[sans identité] no official result', !none.official);
  ok('and the reason says so plainly', !none.official && none.reason.includes('aucune identite'));

  // (b) AN IDENTITY THAT CANNOT BOUND ITSELF. Each of these used to pass as official.
  const noCycle = resolvePilotWindow(row({ activatedDecisionId: null }), null);
  ok('[cycle d\'activation irrésolu] REFUSED', !noCycle.official);
  ok('and named', !noCycle.official && noCycle.reason.includes('irresolu'));
  for (const bad of [null, 0, -5, Number.NaN]) {
    const r = resolvePilotWindow(row({ openingEquityQuote: bad }), null);
    ok(`[equity d'ouverture ${String(bad)}] REFUSED`, !r.official && r.reason.includes('inutilisable'));
  }
  const noInstant = resolvePilotWindow(row({ activatedAt: null }), null);
  ok('[sans instant d\'activation] REFUSED', !noInstant.official && noInstant.reason.includes("instant d'activation"));

  // (c) THE --at CONTRACT. An unknown value refuses; a known one with no pointer refuses too,
  // and never quietly stretches the window to today.
  const unknown = resolvePilotWindow(row(), 'la_semaine_derniere');
  ok('[--at inconnu] REFUSED', !unknown.official && unknown.reason.includes('inconnu'));
  ok('and the accepted values are listed', !unknown.official && unknown.reason.includes('alerte_40'));
  const empty = resolvePilotWindow(row(), '');
  ok('[--at= vide] REFUSED too — asking for nothing is asking badly', !empty.official);
  for (const asked of ['alerte_40', 'arret_50', 'cloture']) {
    const missing = resolvePilotWindow(row(), asked);
    ok(`[--at=${asked} jamais survenu] REFUSED rather than extended`, !missing.official);
    ok(`and it says the instant never happened (${asked})`, !missing.official && missing.reason.includes("n'a pas eu lieu"));
  }
  const stopped = resolvePilotWindow(row({ stoppedAt: '2026-09-06T06:00:00.000Z', stoppedDecisionId: 1700 }), 'arret_50');
  ok('[--at=arret_50 avec pointeur] accepted', stopped.official);
  ok('bounded exactly on it', stopped.official && stopped.toDecisionId === 1700);
  ok('with its own label, not the raw flag', stopped.official && stopped.instant === 'arret_50');

  // (d) WITHOUT --at: the instant that really exists, and the right label for it.
  const bare = resolvePilotWindow(row(), null);
  ok('[sans --at, rien de fermé] the current settled point', bare.official && bare.instant === 'point_courant');
  ok('and no upper cycle is invented', bare.official && bare.toDecisionId === null);
  const withStop = resolvePilotWindow(row({ stoppedAt: '2026-09-06T06:00:00.000Z', stoppedDecisionId: 1700 }), null);
  ok('[sans --at, un arrêt] takes the stop', withStop.official && withStop.instant === 'arret_50' && withStop.toDecisionId === 1700);
  const withBoth = resolvePilotWindow(
    row({ stoppedAt: '2026-09-06T06:00:00.000Z', stoppedDecisionId: 1700, closedAt: '2026-09-06T06:00:00.000Z', closedDecisionId: 1800 }),
    null,
  );
  ok('[sans --at, arrêt ET clôture] the closure wins', withBoth.official && withBoth.instant === 'cloture' && withBoth.toDecisionId === 1800);

  // (e) NO CAST, EVER. The label is one of four known values, never a string from the CLI.
  const labels = ['alerte_40', 'arret_50', 'cloture', 'point_courant'];
  const produced = [
    resolvePilotWindow(row({ alertAt: '2026-09-06T06:00:00.000Z', alertDecisionId: 1600 }), 'alerte_40'),
    withStop,
    withBoth,
    bare,
  ];
  ok(
    'every published instant is one of the four known labels',
    produced.every((r) => r.official && labels.includes(r.instant)),
  );
  const pilotSrc = readFileSync(path.join(ROOT, 'src/exposure/pilot.ts'), 'utf8');
  ok(
    'and the resolver casts the request only after proving it is one of them',
    pilotSrc.includes('} else if (!(requested in known)) {') &&
      pilotSrc.includes('instant = requested as PilotInstant;'),
  );
  const replaySrc = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    'the replay tells an ABSENT flag from an empty one',
    replaySrc.includes("const instantFlag = process.argv.find((arg) => arg.startsWith('--at='));") &&
      replaySrc.includes('instantFlag == null ? null : instantFlag.slice'),
  );
  ok(
    'and a refused window prints the reason instead of the pilot\'s name',
    replaySrc.includes('PAS DE RÉSULTAT OFFICIEL'),
  );
}

// ── PROOF 12 — an event that happened is never stepped over ─────────────────────────
//
// THE DEFECT THIS REPLACES, and it was the worst of the six. Every mandatory write is made
// before the decision row exists — that row has to carry the corrected target — so none of them
// could name its own cycle, and only the activation was ever repaired. After a 50% stop the
// pointer stayed null, the default cascade read that as "no stop", fell through to
// `point_courant` and valued the witnesses PAST the stop: the silent extension of an official
// window, reintroduced by another door.
//
// The cascade is now driven by whether the event HAPPENED, which its instant records durably,
// and never by whether its cycle has been resolved.
console.log('\nProof 12 — an unresolved pointer refuses; it never lets the window run past:');
{
  const T = '2026-09-06T06:00:00.000Z';
  const row = (over: Partial<PilotWindowRow> = {}): PilotWindowRow => ({
    status: 'active',
    activatedAt: '2026-09-06T00:00:00.000Z',
    activatedDecisionId: 1500,
    openingEquityQuote: 1026.26,
    alertAt: null,
    stoppedAt: null,
    closedAt: null,
    alertDecisionId: null,
    stoppedDecisionId: null,
    closedDecisionId: null,
    ...over,
  });

  // (a) THE EXACT DEFECT: a stop that happened, with no cycle resolved yet.
  const stopUnresolved = resolvePilotWindow(row({ stoppedAt: T }), null);
  ok('[arrêt survenu, pointeur nul, sans --at] REFUSED', !stopUnresolved.official);
  ok(
    'it never falls through to the current point',
    !stopUnresolved.official && !stopUnresolved.reason.includes('point_courant'),
  );
  ok(
    'and it says the instant happened but its cycle is unresolved',
    !stopUnresolved.official && stopUnresolved.reason.includes('irresolu'),
  );
  ok(
    'the same holds when the instant is asked for by name',
    !resolvePilotWindow(row({ stoppedAt: T }), 'arret_50').official,
  );
  const closureUnresolved = resolvePilotWindow(row({ closedAt: T }), null);
  ok('[clôture survenue, pointeur nul] REFUSED too', !closureUnresolved.official);
  const alertUnresolved = resolvePilotWindow(row({ alertAt: T }), 'alerte_40');
  ok('[alerte survenue, pointeur nul] REFUSED too', !alertUnresolved.official);

  // AND THE 40% ALERT DOES NOT BOUND THE DEFAULT. It is a warning, not an end: the correction
  // keeps applying, so an unresolved alert must not refuse a run nobody asked to bound there.
  const alertOnly = resolvePilotWindow(row({ alertAt: T }), null);
  ok('[alerte seule, sans --at] the run is still official', alertOnly.official);
  ok('at the current point, because nothing ended', alertOnly.official && alertOnly.instant === 'point_courant');

  // (b) THE REPAIR. Once the cycle is resolved the same window is accepted, bounded exactly on
  // it — which is what makes the recovery observable rather than asserted.
  const repaired = resolvePilotWindow(row({ stoppedAt: T, stoppedDecisionId: 1700 }), null);
  ok('[après réparation] the window is official again', repaired.official);
  ok('bounded exactly on the stop', repaired.official && repaired.toDecisionId === 1700);
  ok('and labelled as the stop', repaired.official && repaired.instant === 'arret_50');
  for (const [instantColumn, idColumn, asked] of [
    ['alertAt', 'alertDecisionId', 'alerte_40'],
    ['stoppedAt', 'stoppedDecisionId', 'arret_50'],
    ['closedAt', 'closedDecisionId', 'cloture'],
  ] as const) {
    const before = resolvePilotWindow(row({ [instantColumn]: T } as Partial<PilotWindowRow>), asked);
    const after = resolvePilotWindow(
      row({ [instantColumn]: T, [idColumn]: 1700 } as Partial<PilotWindowRow>),
      asked,
    );
    ok(`[${asked}] refused before the repair, accepted after`, !before.official && after.official);
  }

  // (c) THE REPAIR IS IDEMPOTENT AND FINDS THE CYCLE FROM THE INSTANT. It never invents an id
  // it did not have, and it only ever fills a hole.
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok(
    'the three pointers are repaired by one pass',
    persistence.includes("instantColumn: 'activated_at'") &&
      persistence.includes("instantColumn: 'alert_drawdown_at'") &&
      persistence.includes("instantColumn: 'stopped_at'"),
  );
  ok(
    'each is found as the first cycle at or after its own instant',
    persistence.includes(".gte('created_at', instant)"),
  );
  // WHICH STATUSES. A threshold is judged on the valuation, before the model is called, so the
  // crossing cycle may end failed — and it is ITS row the pointer must name, not the next
  // decided one, or the official window would run one cycle past the stop. The activation is
  // the exception: it only lands on a decided cycle and seeds the decided-only heartbeat.
  ok(
    'the activation pointer is decided-only; the two threshold pointers are not',
    /idColumn: 'activated_decision_id', decidedOnly: true/.test(persistence) &&
      /idColumn: 'alert_drawdown_decision_id', decidedOnly: false/.test(persistence) &&
      /idColumn: 'stopped_decision_id', decidedOnly: false/.test(persistence) &&
      /pointer\.decidedOnly \? query\.eq\('status', 'decided'\) : query/.test(persistence),
  );
  ok(
    'and the update only ever touches a pointer that is still null',
    persistence.includes('.is(pointer.idColumn, null)'),
  );
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    'the pass runs on every application cycle, not only on the activation',
    /EXPOSURE_BAND_MODE !== 'application'\) return;\s*\n\s*await resolvePilotEventCycles\(supabase\);/.test(decide),
  );
  // ON EVERY PATH THAT INSERTED A ROW AFTER THE JUDGEMENT, not the decided one alone. A
  // threshold is crossed before the model is called, so its cycle may end failed — and a
  // pointer left null until the next decided cycle is a permanent hole if the mode is switched
  // off in between (the pass is gated on `application`). The outage trace is the reference set
  // of persisted terminal paths; the one path without the pass is the fabricated-book refusal,
  // where the pilot never judged. (Second review round.)
  const outageCalls = (decide.match(/await observeMarketDataOutage\(/g) ?? []).length;
  const resolveCalls = (decide.match(/await resolvePilotEvents\(\);/g) ?? []).length;
  ok(`and on every persisted path after the judgement (${resolveCalls} of ${outageCalls} terminal paths)`, outageCalls >= 7 && resolveCalls === outageCalls - 1);
  ok('the one path without it is the fabricated-book refusal, above the judgement', decide.indexOf('await resolvePilotEvents();') > decide.indexOf('refusing to trade on a book we cannot derive'));
  ok('and the old one-shot backfill is gone', !decide.includes('backfillActivationDecision'));
}

// ── PROOF 13 — a null heartbeat is read, never waived ───────────────────────────────
//
// The guard used to be `lastSeen != null && latest > lastSeen`, so a null heartbeat skipped the
// interruption check entirely — the one hole the check exists to close. A null now falls back on
// the activation baseline, which the activation cycle freezes precisely so that "nothing has
// happened yet" and "something happened unseen" stop being the same value.
console.log('\nProof 13 — a pilot with no receipt yet still has to prove its continuity:');
{
  // (a) CRASH BEFORE ANY DECISION. The activation row landed, the cycle died before its own
  // decision row was written. Nothing has been decided since: resumption stays possible.
  const bornOnly = judge({
    identity: identity({ lastSeenDecisionId: null, activationBaselineDecisionId: 1500 }),
    latestDecidedDecisionId: 1500,
  });
  ok('[crash avant décision] the pilot may resume', bornOnly.mayCorrect);
  ok('and nothing is invalidated', bornOnly.statusAfter === 'active');

  // (b) CRASH AFTER THE DECISION, BEFORE THE RECEIPT. A decided cycle exists that the pilot
  // never marked — a hole in the high-water history, and the identity ends.
  const orphaned = judge({
    identity: identity({ lastSeenDecisionId: null, activationBaselineDecisionId: 1500 }),
    latestDecidedDecisionId: 1501,
  });
  ok('[crash après décision, avant battement] the interruption is detected', orphaned.hold === 'pilote_interrompu');
  ok('the correction stands down', !orphaned.mayCorrect);
  ok('and the identity is invalidated durably', orphaned.statusAfter === 'interrupted_mode');
  ok(
    'the recorded hole starts at the baseline, which is what it really knew',
    orphaned.write?.kind === 'interrupt_mode' && orphaned.write.lastSeenDecisionId === 1500,
  );

  // (c) NEITHER MARK. A pilot that can prove nothing about its own continuity does not resume.
  ok(
    '[ni battement ni référence] the check is not skippable',
    judge({
      identity: identity({ lastSeenDecisionId: null, activationBaselineDecisionId: null }),
      latestDecidedDecisionId: 1501,
    }).hold === 'pilote_interrompu',
  );

  // (d) THE BASELINE IS WRITTEN BY THE ACTIVATION ITSELF, from the read the same cycle made.
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok(
    'the activation freezes the journal state it observed',
    persistence.includes('activation_baseline_decision_id: ctx.latestDecidedDecisionId'),
  );
  const pilotSrc = readFileSync(path.join(ROOT, 'src/exposure/pilot.ts'), 'utf8');
  ok(
    'and a null receipt falls back on it rather than exempting the cycle',
    pilotSrc.includes('identity.lastSeenDecisionId ?? identity.activationBaselineDecisionId'),
  );
}

// ── PROOF 14 — the four remaining findings ──────────────────────────────────────────
console.log('\nProof 14 — the reserve, the persisted status, the settled bound, the closed window:');
{
  // (D) THE RESERVE IS PART OF THE CONTRACT. Same four base assets, different quote: every order
  // symbol and the reserved line change, and the pilot must not survive it.
  const usdc = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDC', 'enforce');
  ok('[réserve] USDT and USDC are different contracts', contractDigest(usdc) !== SHA);
  // THE GATE'S MODE IS PART OF THE CONTRACT TOO. Under `enforce` the code generates its own
  // stop exits, a forbidden leg refuses the whole vector, and `stoppedWeightSurvives` flips —
  // three different behaviours of the same correction, so moving the mode must end the pilot.
  const observeContract = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT', 'observe');
  ok('[porte] observe and enforce are different contracts', contractDigest(observeContract) !== SHA);
  ok(
    'and a pilot activated under one is invalidated by the other',
    judge({ contractSha256: contractDigest(observeContract) }).hold === 'contrat_divergent',
  );
  ok(
    'the mode is frozen in the identity, so a replay never reads the machine it runs on',
    readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8').includes('transition_mode: ctx.transitionMode'),
  );
  ok('and the same reserve keeps the same digest', contractDigest(pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT', 'enforce')) === SHA);

  // (E) THE PERSISTED STATUS IS A STATUS. It used to persist correctly and be rejected on the
  // way back, so every cycle after an interruption reported an unreadable identity instead.
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  const known = persistence.slice(persistence.indexOf('const KNOWN_STATUS'), persistence.indexOf('export async function readPilotIdentity'));
  ok('[statut] the reader accepts every status the migration allows', ['active', 'stopped_drawdown', 'invalidated_contract', 'interrupted_mode'].every((st) => known.includes(`'${st}'`)));
  const migration = readFileSync(path.join(ROOT, 'supabase/migrations/0035_exposure_pilot_interruption.sql'), 'utf8');
  ok(
    'and the two vocabularies are the same four',
    ['active', 'stopped_drawdown', 'invalidated_contract', 'interrupted_mode'].every((st) => migration.includes(`'${st}'`)),
  );
  ok(
    'so the journaled cause stays pilote_interrompu',
    judge({ identity: identity({ status: 'interrupted_mode' }) }).hold === 'pilote_interrompu',
  );

  // (C) A BOUND BEYOND THE SETTLED POINT REFUSES, and never prints the requested pointer as
  // reached.
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandWitnesses.ts'), 'utf8');
  ok(
    '[borne] an official endpoint past the settled cutoff is refused',
    replay.includes('resolved.toDecisionId > cutoffId') && replay.includes('le rejeu refuse plutot que de tronquer'),
  );
  ok('and nothing is truncated with Math.min any more', !replay.includes('Math.min(pilotWindow.toDecisionId, cutoffId)'));

  // (F) A CLOSED WINDOW IS NOT RE-EVALUATED. It used to rescan every coverage row, re-log the
  // closure and issue an update matching nothing, on every cycle for the rest of the pilot.
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    '[fenêtre] the closure state is read and short-circuits the work',
    decide.includes('if (identity.windowClosedAt != null) return;'),
  );
  ok(
    'and it is actually read back from the row',
    persistence.includes('window_closed_at') && persistence.includes('windowClosedAt: row.window_closed_at'),
  );
  ok(
    'closing still leaves the correction running — the status is untouched',
    !/closeMeasurementWindow[\s\S]*?status:/.test(persistence),
  );
}

// ── PROOF 15 — the high-water mark sees every admissible valuation ──────────────────
//
// THE DEFECT. The judgement lived on the decided path, so the peak was only ever measured on
// cycles the model and the guard let through. On 14/09 the identity held a peak of
// 1 079,65 $; cycles 2027 and 2028 ended `guard_failed` with the same sovereign book valued at
// 1 081,72 $ and 1 081,31 $, and neither was seen. Their observation rows carried NULL in all
// three pilot columns — and NULL in `pilot_hold` is the value that means "the correction was
// allowed to touch the orders", which is the opposite of what happened.
//
// THE RULE. The pilot judges the VALUATION on every cycle that reached a sovereign book,
// before the model is called. A valuation is admissible when the equity is finite and positive
// and every held line has a live price. On an admissible one the peak may rise and both
// thresholds may fire, whatever the cycle goes on to do; on a fallback-priced one nothing
// irreversible is built. The interruption and the heartbeat keep their own definition — they
// are about DECIDED cycles, and they are not bent here to say which equities count.
console.log('\nProof 15 — a failed cycle with a reliable valuation still feeds the high-water mark:');
{
  // A test-side mirror of `applyPilotWrite`'s patch, so a scenario can be walked cycle by
  // cycle on the pure function alone. Only the fields the walk reads are carried.
  const applied = (id: PilotIdentity, write: PilotWrite | null): PilotIdentity => {
    if (write == null) return id;
    switch (write.kind) {
      case 'peak':
        return { ...id, peakEquityQuote: write.peakEquityQuote };
      case 'alert_drawdown':
        return { ...id, peakEquityQuote: write.peakEquityQuote, alertDrawdownAt: '2026-09-15T00:00:00.000Z' };
      case 'stop_drawdown':
        return { ...id, peakEquityQuote: write.peakEquityQuote, status: 'stopped_drawdown' };
      case 'interrupt_mode':
        return { ...id, status: 'interrupted_mode' };
      case 'invalidate_contract':
        return { ...id, status: 'invalidated_contract' };
      case 'activation':
        return identity({ openingEquityQuote: write.openingEquityQuote, peakEquityQuote: write.peakEquityQuote });
    }
  };

  // (a) THE REAL CASE, on the real numbers. The judgement has no way to know how the cycle will
  // end — `PilotJudgeInput` carries no status — so a `guard_failed` cycle is judged exactly as
  // a decided one, and its equity raises the mark.
  const prod = identity({ peakEquityQuote: 1079.6518118063, openingEquityQuote: 1077.1033053103 });
  const cycle2027 = judge({ identity: prod, equityQuote: 1081.72 });
  ok('[guard_failed, 2027] the valuation establishes a new high-water mark', cycle2027.write?.kind === 'peak');
  ok('at the cycle\'s own equity', cycle2027.write?.kind === 'peak' && cycle2027.write.peakEquityQuote === 1081.72);
  ok('the drawdown reported on that row is zero — it IS the peak', cycle2027.drawdownPercent === 0);
  const after2027 = applied(prod, cycle2027.write);
  const cycle2028 = judge({ identity: after2027, equityQuote: 1081.31 });
  ok('[guard_failed, 2028] the next one measures from the mark 2027 set', after2027.peakEquityQuote === 1081.72 && cycle2028.write === null);
  ok(
    'and its drawdown is the honest 0.04%, not the 0% a lost peak would have shown',
    Math.abs((cycle2028.drawdownPercent ?? 0) - ((1081.72 - 1081.31) / 1081.72) * 100) < 1e-9,
  );

  // (b) AN `error` CYCLE is the same cycle to the pilot: the model never answered, the book was
  // valued all the same. Nothing in the judgement distinguishes the two failure kinds, and the
  // structural checks in (h) prove both reach the block.
  const errorCycle = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 1300 });
  ok('[error] a reliable valuation raises the mark on an errored cycle too', errorCycle.write?.kind === 'peak' && errorCycle.write.peakEquityQuote === 1300);
  ok('and no order can follow from it — the verdict carries no movement', !('movements' in errorCycle));

  // (c) WHY IT MATTERS — the breaker bites late without it. Peak 1000; a guard_failed cycle at
  // 1200; then a decided cycle at 700. Seen, the drawdown is 41.7% and the 40% alert fires.
  // Unseen, it is 30% and nothing does.
  const seen = applied(identity({ peakEquityQuote: 1000 }), judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 1200 }).write);
  const withPeak = judge({ identity: seen, equityQuote: 700 });
  const withoutPeak = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 700 });
  ok('[sommet vu sur un cycle en échec] the 40% alert fires on the next decided cycle', withPeak.alert === 'drawdown_40');
  ok('[sommet manqué] it would not have — the defect understated the drawdown', withoutPeak.alert === null && (withoutPeak.drawdownPercent ?? 0) < 31);

  // (d) A FALLBACK PRICE builds nothing irreversible. `derivePortfolio` values a held line at
  // its average cost when the ticker is missing; the pilot refuses to ratchet or to trip on it.
  ok('[valuationHold] a fallback-priced line is named', valuationHold({ equityQuote: 1000, fallbackPricedAssets: ['ETH'] }) === 'prix_de_repli');
  ok('a non-finite or non-positive equity keeps its own name', valuationHold({ equityQuote: 0, fallbackPricedAssets: [] }) === 'equite_inutilisable' && valuationHold({ equityQuote: Number.NaN, fallbackPricedAssets: ['ETH'] }) === 'equite_inutilisable');
  ok('and an ordinary valuation is admissible', valuationHold({ equityQuote: 1000, fallbackPricedAssets: [] }) === null);
  const stale = identity({ peakEquityQuote: 1000 });
  const staleHigh = judge({ identity: stale, equityQuote: 5000, fallbackPricedAssets: ['ETH'] });
  ok('[prix de repli, +400%] no new peak is written', staleHigh.write === null);
  ok('the correction stands down', !staleHigh.mayCorrect && staleHigh.hold === 'prix_de_repli');
  ok('the row still reports the peak the breaker knew', staleHigh.peakEquityQuote === 1000);
  ok('and no drawdown, because there is no honest number for it', staleHigh.drawdownPercent === null);
  const staleLow = judge({ identity: stale, equityQuote: 400, fallbackPricedAssets: ['BTC'] });
  ok('[prix de repli, -60%] the 50% stop does NOT trip on a fallback price', staleLow.write === null && staleLow.alert === null && staleLow.statusAfter === 'active');
  ok('nor does the 40% alert', judge({ identity: stale, equityQuote: 600, fallbackPricedAssets: ['BTC'] }).alert === null);
  // THE PILOT ITSELF IS NOT ENDED BY A MISSING TICKER. The status stays active so the heartbeat
  // is still written on a decided cycle: a bar with no reading is not a cycle that ran unseen.
  ok('the pilot stays active — a missing ticker must not end an eight-week experiment', staleLow.statusAfter === 'active');
  // DELIBERATE, AND NEW: an unusable equity on an ACTIVE identity used to answer with no status,
  // so the heartbeat was skipped and the next cycle read an interruption. Both unreliable
  // valuations now share one posture — nothing durable, the pilot continues.
  ok('and so does an equity of 0 — the two unreliable valuations share one posture', judge({ identity: stale, equityQuote: 0 }).statusAfter === 'active' && judge({ identity: stale, equityQuote: 0 }).write === null);
  ok('no activation on a fallback valuation — the opening equity IS the first peak', judge({ identity: null, equityQuote: 1000, fallbackPricedAssets: ['ETH'] }).write === null);
  ok('and it is named, not silent', judge({ identity: null, equityQuote: 1000, fallbackPricedAssets: ['ETH'] }).hold === 'prix_de_repli');
  // THE ORDER OF THE CHECKS. A fallback price is a fact about the tickers; the interruption and
  // the contract are facts about the journal and the configuration, and they are judged first.
  ok(
    'an interruption is still detected on a fallback-priced cycle',
    judge({ identity: identity({ lastSeenDecisionId: 1500 }), latestDecidedDecisionId: 1501, fallbackPricedAssets: ['ETH'] }).write?.kind === 'interrupt_mode',
  );
  ok(
    'and so is a diverged contract',
    judge({ identity: identity({ contractSha256: 'autre' }), fallbackPricedAssets: ['ETH'] }).write?.kind === 'invalidate_contract',
  );
  ok('a stopped pilot names the stop, not the price', judge({ identity: identity({ status: 'stopped_drawdown' }), fallbackPricedAssets: ['ETH'] }).hold === 'pilote_arrete_drawdown');

  // (e) A 40% CROSSING ON A FAILED CYCLE persists the alert and creates no order. The write is
  // the same durable latch; the journal says the cycle never reached a correction.
  const failedAt40 = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 600 });
  ok('[40% sur cycle en échec] the alert is decided', failedAt40.alert === 'drawdown_40');
  ok('and latched durably — the write does not depend on the cycle\'s outcome', failedAt40.write?.kind === 'alert_drawdown');
  ok('the journal reads cycle_non_decide, never null', journalPilotHold(failedAt40.hold, false) === 'cycle_non_decide');
  ok('while the numbers beside it are the breaker\'s', Math.abs((failedAt40.drawdownPercent ?? 0) - 40) < 1e-9 && failedAt40.peakEquityQuote === 1000);
  ok('on the following decided cycle the alert does not fire again', judge({ identity: applied(identity({ peakEquityQuote: 1000 }), failedAt40.write), equityQuote: 550 }).alert === null);

  // (f) A 50% CROSSING ON A FAILED CYCLE stops the correction durably, and liquidates nothing.
  const failedAt50 = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 500 });
  ok('[50% sur cycle en échec] the breaker trips', failedAt50.alert === 'drawdown_50' && failedAt50.write?.kind === 'stop_drawdown');
  ok('the status becomes terminal', failedAt50.statusAfter === 'stopped_drawdown');
  ok('the journal names the stop — the pilot\'s own reason wins over the cycle\'s', journalPilotHold(failedAt50.hold, false) === 'pilote_arrete_drawdown');
  const stoppedOnFailure = applied(identity({ peakEquityQuote: 1000 }), failedAt50.write);
  ok('the next decided cycle finds the correction disarmed', !judge({ identity: stoppedOnFailure, equityQuote: 900 }).mayCorrect);
  ok('and a recovery does not re-arm it', judge({ identity: stoppedOnFailure, equityQuote: 2000 }).hold === 'pilote_arrete_drawdown');
  ok('nothing in the verdict can liquidate', !('liquidate' in failedAt50) && !('movements' in failedAt50));

  // (g) THE JOURNAL distinguishes a cycle that was not judged from one where the correction
  // applied. Null is now reserved for the latter.
  ok('[journal] the correction applied → null', journalPilotHold(null, true) === null);
  ok('the cycle never reached a correction → cycle_non_decide', journalPilotHold(null, false) === 'cycle_non_decide');
  ok('the pilot\'s own reason always wins', journalPilotHold('mode_inactif', false) === 'mode_inactif' && journalPilotHold('prix_de_repli', true) === 'prix_de_repli');
  const migration = readFileSync(path.join(ROOT, 'supabase/migrations/0038_exposure_pilot_admissible_valuation.sql'), 'utf8');
  ok('the database accepts both new values', migration.includes("'cycle_non_decide'") && migration.includes("'prix_de_repli'"));
  ok('and every value the code can produce', ['mode_inactif', 'identite_illisible', 'ecriture_obligatoire_impossible', 'pilote_arrete_drawdown', 'pilote_invalide_contrat', 'pilote_interrompu', 'contrat_divergent', 'equite_inutilisable'].every((h) => migration.includes(`'${h}'`)));
  ok('the migration backfills nothing and touches no identity', !/update\s+public\.exposure_pilot|update\s+public\.exposure_band_observations|insert\s+into/i.test(migration));

  // (h) THE WIRING. `decide.ts` is not unit-testable, so its shape is proven the way the other
  // proofs prove it: the judgement sits between the fabricated-book refusal and the model call,
  // every observation row carries a verdict, and no failure path can reach the executor.
  // Normalised to LF: the checkout's line endings are not part of what is being proven (#42).
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8').replace(/\r\n/g, '\n');
  const at = (needle: string | RegExp): number => {
    const idx = typeof needle === 'string' ? decide.indexOf(needle) : decide.search(needle);
    assert.ok(idx >= 0, `not found in decide.ts: ${String(needle)}`);
    return idx;
  };
  const judgementAt = at('const pilotJudgement = judgePilot({');
  const fabricatedBookRefusal = at('refusing to trade on a book we cannot derive');
  const lifecycleRefusal = at('refusing to trade on a lifecycle we cannot record');
  const llmCallAt = at('const llmStart = Date.now();');
  ok('[câblage] the judgement comes AFTER the fabricated-book refusal', judgementAt > fabricatedBookRefusal);
  // THE SECOND REVIEW ROUND'S FINDING. The three lifecycle reads used to refuse as one, and a
  // failed position-state or reference read — which leaves the book sovereign and live-priced
  // — returned before the pilot could see it. Only the journal's failure fabricates a book.
  ok('but BEFORE the lifecycle refusal — that book is sovereign and its peak is real', judgementAt < lifecycleRefusal);
  ok('the two refusals are split on the one read that fabricates the book', /if \(!ledgerRead\.ok\) \{/.test(decide) && /if \(!stateRead\.ok \|\| referenceUnavailable\) \{/.test(decide));
  ok('and BEFORE the model is called', judgementAt < llmCallAt);
  ok('it is made exactly once per cycle', (decide.match(/judgePilot\(\{/g) ?? []).length === 1);
  ok('the fallback-priced lines are passed from the book\'s own flag', /fallbackPricedAssets: portfolio\.positions\.filter\(\(p\) => p\.priceStale\)/.test(decide));
  // THE THIRD REVIEW ROUND. Nothing of the pilot's is written before the model: the two reads
  // ride in the lifecycle's own batch (no added latency, no shifted retry gate), and the write
  // plus its alert land in `settlePilot` — after the guard on the decided path, exactly where
  // the block lived before this fix, and at the tail of every failure path.
  const batchAt = at('const [stateRead, referenceRead, pilotRead, latestDecidedDecisionId] = await Promise.all([');
  ok('the two reads ride in the lifecycle batch, before the judgement', batchAt < judgementAt && batchAt < fabricatedBookRefusal);
  // Between the judgement and the model call, the only pilot I/O is inside `settlePilot`'s
  // DEFINITION, and the only calls to it sit in terminal skip branches that return before the
  // model. Checked by position rather than by stripping text, so a stray call cannot hide.
  const preModel = decide.slice(judgementAt, llmCallAt);
  const settleDef = { from: preModel.indexOf('const settlePilot = async'), to: preModel.indexOf('\n  };', preModel.indexOf('const settlePilot = async')) };
  const inside = (idx: number): boolean => idx > settleDef.from && idx < settleDef.to;
  const positions = (needle: string): number[] => [...preModel.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => m.index!);
  ok('the write itself is issued from one place, the settlement', (decide.match(/await applyPilotWrite\(/g) ?? []).length === 1 && positions('await applyPilotWrite(').every(inside));
  ok('every settlement before the model sits in a skip branch that returns', positions('await settlePilot(false, id);').length === 2 && positions('await settlePilot(false, id);').every((idx) => {
    const branchEnd = preModel.indexOf('\n  }', idx);
    return preModel.slice(idx, branchEnd).includes("return emptyResult('skipped'");
  }));
  ok('and the only Telegram send before the model is the settlement\'s own', positions('await sendTelegram(').length === 1 && positions('await sendTelegram(').every(inside));
  const settlementAt = at('await settlePilot(true, null);');
  ok('the decided path settles after the guard, where the block used to live', settlementAt > at('const { clamp, movements: proposedMovements } = evaluated;'));
  ok('and before any order', settlementAt < at('let correctedAllocation = clamp.applied;'));
  ok('the activation lands on the decided path only', /if \(activationPending && !correctionReached\) return;/.test(decide));
  ok('every failure path settles at its tail, before its observation', (decide.match(/await settlePilot\(false, id\);\s*\n\s*await observeExposureBand\(\{/g) ?? []).length === 5);
  // THE FOURTH REVIEW ROUND. A failure path settles AFTER its row exists, so the event's instant
  // is later than the row's `created_at` and the instant-based repair could never find it. The
  // row's id is known there, and it is written into the pointer outright; only the decided path
  // — where the row does not exist yet — leaves it null for the repair pass.
  ok('a failure path names its own row in the write', (decide.match(/await settlePilot\(false, id\);/g) ?? []).length === 5 && /const settlePilot = async \(correctionReached: boolean, decisionId: number \| null\)/.test(decide) && /decisionId,\s*\n\s*latestDecidedDecisionId,/.test(decide));
  ok('and the decided path, whose row does not exist yet, leaves it to the repair', /await settlePilot\(true, null\);/.test(decide));
  const persistenceSrc = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok('the write puts that id on the alert, the stop and the peak pointers', persistenceSrc.includes('patch.alert_drawdown_decision_id = ctx.decisionId;') && persistenceSrc.includes('patch.stopped_decision_id = ctx.decisionId;') && persistenceSrc.includes('patch.peak_decision_id = ctx.decisionId;'));
  const observations = decide.match(/observeExposureBand\(\{[\s\S]*?\}\);/g) ?? [];
  ok(`every observation row carries a verdict (${observations.length} call sites)`, observations.length >= 7 && observations.every((call) => /pilot: (pilotJournal\(|\{)/.test(call)));
  ok('the failure paths journal the valuation as not judged', (decide.match(/pilot: pilotJournal\(false\)/g) ?? []).length >= 5);
  ok('and the decided path as reached', (decide.match(/pilot: pilotJournal\(true\)/g) ?? []).length === 1);
  ok('the verdict is no longer optional on a row', /pilot: \{ hold: PilotJournalHold \| null;/.test(decide) && !/pilot\?: \{/.test(decide));
  // NO ORDER ON A FAILED CYCLE. The executor is reached from exactly one place, and that place
  // sits after the decided row has been inserted — every failure path has returned by then.
  const executorCalls = decide.match(/await executeMovements\(/g) ?? [];
  ok('the executor is called from exactly one place', executorCalls.length === 1);
  const decidedRowAt = at("status: 'decided',\n    target_allocation: v.targetAllocation,");
  ok('after the decided row exists', at('await executeMovements(') > decidedRowAt);
  ok('and the failure helper returns without ever reaching it', at('const failCycle = async (') < decidedRowAt && !/const failCycle = async \([\s\S]*?executeMovements[\s\S]*?return emptyResult\(status/.test(decide));

  // (i) WHAT DID NOT MOVE. The heartbeat and the interruption keep their definition — decided
  // cycles — and decided cycles keep their behaviour: the standard walk of proof 3 is the same
  // judgement, made from the same inputs, one call earlier in the cycle.
  ok('[inchangé] the heartbeat is still written only on a decided row', /EXPOSURE_BAND_MODE === 'application' && id != null && pilotJudgement\.statusAfter === 'active'/.test(decide));
  const persistence = readFileSync(path.join(ROOT, 'src/persistence/exposurePilot.ts'), 'utf8');
  ok('and the interruption is still judged against decided cycles only', /readLatestDecidedDecisionId[\s\S]{0,600}?\.eq\('status', 'decided'\)/.test(persistence));
  const walk = identity({ peakEquityQuote: 1000, openingEquityQuote: 1000 });
  ok('a decided cycle at 10% still applies, quietly', judge({ identity: walk, equityQuote: 900 }).mayCorrect && judge({ identity: walk, equityQuote: 900 }).write === null);
  ok('a decided cycle at a new high still writes the peak and applies', judge({ identity: walk, equityQuote: 1100 }).write?.kind === 'peak' && judge({ identity: walk, equityQuote: 1100 }).mayCorrect);
  ok('the contract digest did not move — the running pilot is not invalidated by this fix', contractDigest(pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT', 'enforce')) === SHA);
  ok('and the contract version is still A.1', config.exposurePilot.contractVersion === 'A.1');
}

// ── PROOF 16 — a cycle that left no row leaves nothing, and a later cycle never inherits it ──
//
// THE FIFTH REVIEW ROUND. On a failure path the settlement runs after the row insert, and
// `insertDecision` returns a null id when that insert failed. Had the threshold been persisted
// then, it would carry no pointer, and the instant-based repair would bind it to the first row
// it finds — a LATER cycle's, which would become the triggering cycle of a crossing it never
// saw, and the official window would be cut on it.
//
// Arbitrated, the minimal option: no durable row → nothing durable from the pilot. No peak, no
// alert, no stop; no repair pass either. The RESIDUAL is stated rather than hidden: that
// cycle's valuation is lost if the market moves before the next cycle, which judges its own.
console.log('\nProof 16 — a crossing on a cycle with no row binds to nothing, ever:');
{
  // (1) THE CROSSING. Peak 1000, this cycle's equity 600: the 40% alert is decided.
  const crossing = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 600 });
  ok('[1] the threshold is crossed and the latch is decided', crossing.alert === 'drawdown_40' && crossing.write?.kind === 'alert_drawdown');

  // (2) THE INSERT FAILS. The settlement is handed a null id on a non-decided path and writes
  // NOTHING — proven on the wiring, since the rule lives there.
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8').replace(/\r\n/g, '\n');
  const settle = decide.slice(decide.indexOf('const settlePilot = async'), decide.indexOf('\n  };', decide.indexOf('const settlePilot = async')));
  const guardAt = settle.indexOf('if (!correctionReached && decisionId == null) {');
  ok('[2] a non-decided path with no row returns before the write', guardAt >= 0 && settle.slice(guardAt, settle.indexOf('await applyPilotWrite(')).includes('return;') && guardAt < settle.indexOf('await applyPilotWrite('));
  ok('nothing at all is written there — the write call is the only one, and it comes after', (settle.match(/await applyPilotWrite\(/g) ?? []).length === 1);
  ok('and no repair pass runs on a failure path without a row', (decide.match(/if \(id != null\) await resolvePilotEvents\(\);/g) ?? []).length === 5 && (decide.match(/await resolvePilotEvents\(\);/g) ?? []).length === 6);
  ok('the decided path is untouched by the rule — the guard is scoped to non-decided paths', /await settlePilot\(true, null\);/.test(decide) && settle.includes('!correctionReached && decisionId == null'));

  // (3) + (4) A LATER DECISION IS CREATED, AND THE REPAIR PASS FINDS NOTHING TO BIND TO IT.
  // The real resolver, run against an in-memory client: the identity as the failed cycle left
  // it (no instant persisted), and a decided row created afterwards. Then the contrast — the
  // identity as the previous code would have left it (instant persisted, pointer null) — to
  // show what the withheld write would have caused.
  const T_CROSSING = '2026-09-17T10:00:00.000Z';
  const T_LATER = '2026-09-17T11:05:00.000Z';
  type PilotRow = Record<string, string | number | null>;
  const fakeClient = (pilot: PilotRow, decisions: Array<{ id: number; status: string; created_at: string }>) => {
    const updates: Array<{ patch: Record<string, unknown>; onlyIfNull: string | null }> = [];
    const builder = (table: string) => {
      const state = { op: 'select' as 'select' | 'update', patch: {} as Record<string, unknown>, onlyIfNull: null as string | null, gte: null as string | null, decidedOnly: false };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, order: self, limit: self, abortSignal: self,
        update: (patch: Record<string, unknown>) => { state.op = 'update'; state.patch = patch; return chain; },
        is: (col: string, value: unknown) => { if (value === null) state.onlyIfNull = col; return chain; },
        gte: (_col: string, value: string) => { state.gte = value; return chain; },
        eq: (col: string, value: string) => { if (col === 'status' && value === 'decided') state.decidedOnly = true; return chain; },
        then: (resolve: (v: { data: unknown; error: null }) => void) => {
          if (table === 'exposure_pilot' && state.op === 'update') {
            if (state.onlyIfNull == null || pilot[state.onlyIfNull] == null) {
              updates.push({ patch: state.patch, onlyIfNull: state.onlyIfNull });
              Object.assign(pilot, state.patch);
            }
            resolve({ data: null, error: null });
          } else if (table === 'exposure_pilot') {
            resolve({ data: [pilot], error: null });
          } else {
            const rows = decisions
              .filter((d) => (state.gte == null || d.created_at >= state.gte) && (!state.decidedOnly || d.status === 'decided'))
              .sort((a, b) => a.id - b.id)
              .map((d) => ({ id: d.id }));
            resolve({ data: rows, error: null });
          }
        },
      });
      return chain;
    };
    return { client: { from: builder } as unknown as SupabaseClient, updates };
  };
  const basePilot = (): PilotRow => ({
    activated_at: '2026-09-06T11:46:10.481Z', activated_decision_id: 1839,
    alert_drawdown_at: null, alert_drawdown_decision_id: null,
    stopped_at: null, stopped_decision_id: null,
  });
  const laterDecision = [{ id: 2100, status: 'decided', created_at: T_LATER }];

  const withheldPilot = basePilot();
  const withheld = fakeClient(withheldPilot, laterDecision);
  await resolvePilotEventCycles(withheld.client);
  ok('[3] a later decided cycle exists; [4] the repair pass binds nothing to it', withheld.updates.length === 0);
  ok('and the identity still carries no alert and no pointer — the crossing left no trace, as arbitrated', withheldPilot.alert_drawdown_at === null && withheldPilot.alert_drawdown_decision_id === null && withheldPilot.stopped_decision_id === null);

  // THE CONTRAST — what the previous code would have persisted (the instant, no pointer), and
  // what the pass then does with it: the later cycle becomes the triggering cycle.
  const leaked = fakeClient({ ...basePilot(), alert_drawdown_at: T_CROSSING }, laterDecision);
  await resolvePilotEventCycles(leaked.client);
  ok(
    '[contraste] a persisted instant with no row WOULD have bound the later cycle as the trigger',
    leaked.updates.length === 1 && leaked.updates[0]!.patch['alert_drawdown_decision_id'] === 2100,
  );

  // THE NEXT CYCLE JUDGES ITS OWN VALUATION, not the lost one. Recovered above 40%: no alert,
  // nothing inherited. Still below: the alert fires on THAT cycle, which really did cross.
  const recovered = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 650 });
  ok('[résidu] the next cycle, recovered to 35%, fires nothing — the 40% crossing is lost', recovered.alert === null && recovered.write === null);
  const stillDown = judge({ identity: identity({ peakEquityQuote: 1000 }), equityQuote: 590 });
  ok('and a next cycle still below 40% crosses on its own account, as its own trigger', stillDown.alert === 'drawdown_40');
  // The README says so in as many words, and does not promise the next cycle re-judges it.
  const readme = readFileSync(path.join(ROOT, 'src/exposure/README.md'), 'utf8');
  ok('the residual is written down, not papered over', /peut être perdue/.test(readme) && /aucune trace durable/.test(readme));
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
