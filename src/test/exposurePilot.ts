import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config, resolveExposureBandMode } from '../config/index.js';
import {
  contractDigest,
  judgePilot,
  judgeWindowClosure,
  pilotAlertMessage,
  pilotContractOf,
  resolvePilotWindow,
  type PilotAlert,
  type PilotIdentity,
  type PilotWindowRow,
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
const CONTRACT = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT');
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
    'each is found as the first DECIDED cycle at or after its own instant',
    persistence.includes(".eq('status', 'decided')") && persistence.includes(".gte('created_at', instant)"),
  );
  ok(
    'and the update only ever touches a pointer that is still null',
    persistence.includes('.is(pointer.idColumn, null)'),
  );
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    'the pass runs on every application cycle, not only on the activation',
    /EXPOSURE_BAND_MODE === 'application'\) \{\s*\n\s*await resolvePilotEventCycles\(supabase\);/.test(decide),
  );
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
  const usdc = pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDC');
  ok('[réserve] USDT and USDC are different contracts', contractDigest(usdc) !== SHA);
  ok('and the same reserve keeps the same digest', contractDigest(pilotContractOf(config, ['BTC', 'ETH', 'BNB', 'XRP'], 'USDT')) === SHA);

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
