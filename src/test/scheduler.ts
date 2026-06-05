import assert from 'node:assert/strict';
import {
  isDue,
  isLockLive,
  canClaim,
  missedBeats,
  classifyOutcome,
  nextConsecutiveFailures,
  backoffMinutes,
  nextDelayMinutes,
  nextFloorStreak,
} from '../scheduler/policy.js';

/**
 * Scheduler policy test — run via `npm test` (tsx). No framework, no network, no
 * cron. These exercise the PURE decision logic. Note: the real ATOMICITY of the
 * claim is a property of the single conditional UPDATE in `claim_due_run` (the DB);
 * `canClaim` only mirrors its WHERE clause. The empirical concurrency proof is the
 * live two-parallel-beats test, never this suite.
 */

const MIN = 60_000;
const NOW = 1_700_000_000_000; // fixed reference instant (ms), for determinism

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

console.log('Scheduler policy — due/lock, claim guard, reschedule, backoff, overheating:');

// Due vs not due (null next_check = first run ever → due immediately).
ok('null next_check is due (first run)', isDue(null, NOW));
ok('past next_check is due', isDue(NOW - MIN, NOW));
ok('future next_check is not due', !isDue(NOW + MIN, NOW));

// Lock liveness + the claim guard (mirror of the atomic WHERE that prevents a 2nd run).
ok('no lock → not live', !isLockLive(null, NOW));
ok('future lock is live', isLockLive(NOW + MIN, NOW));
ok('expired lock is not live', !isLockLive(NOW - MIN, NOW));
ok('canClaim: due + no lock → true', canClaim({ nextCheckAtMs: NOW - MIN, lockedUntilMs: null }, NOW));
ok('canClaim: a LIVE lock blocks a second concurrent run', !canClaim({ nextCheckAtMs: NOW - MIN, lockedUntilMs: NOW + MIN }, NOW));
ok('canClaim: an EXPIRED lock allows reclaim of a crashed run', canClaim({ nextCheckAtMs: NOW - MIN, lockedUntilMs: NOW - 1 }, NOW));
ok('canClaim: not due → false even when unlocked', !canClaim({ nextCheckAtMs: NOW + MIN, lockedUntilMs: null }, NOW));

// Status → outcome mapping.
ok('decided → decided', classifyOutcome('decided') === 'decided');
ok('skipped → skip', classifyOutcome('skipped') === 'skip');
ok('parse_failed → error (no usable decision)', classifyOutcome('parse_failed') === 'error');
ok('error → error', classifyOutcome('error') === 'error');

// Reschedule ALWAYS, with the right delay per outcome.
const d = { softSkipDelayMinutes: 30, minDelayMinutes: 15, maxDelayMinutes: 240 };
ok('decided → the LLM bounded delay', nextDelayMinutes('decided', { ...d, appliedDelayMinutes: 60, failuresAfter: 0 }) === 60);
ok('decided clamps an out-of-range delay to the cap', nextDelayMinutes('decided', { ...d, appliedDelayMinutes: 9999, failuresAfter: 0 }) === 240);
ok('skip → modest fixed repli (30)', nextDelayMinutes('skip', { ...d, appliedDelayMinutes: null, failuresAfter: 0 }) === 30);
ok('error → backoff (15 on the first failure)', nextDelayMinutes('error', { ...d, appliedDelayMinutes: null, failuresAfter: 1 }) === 15);

// Backoff progression + reset on a successful (or skipped) cycle.
ok('backoff 1 → 15', backoffMinutes(1, 15, 240) === 15);
ok('backoff 2 → 30', backoffMinutes(2, 15, 240) === 30);
ok('backoff 3 → 60', backoffMinutes(3, 15, 240) === 60);
ok('backoff 4 → 120', backoffMinutes(4, 15, 240) === 120);
ok('backoff 5 → 240 (cap)', backoffMinutes(5, 15, 240) === 240);
ok('backoff 9 → 240 (still capped)', backoffMinutes(9, 15, 240) === 240);
ok('failures increment on a hard error', nextConsecutiveFailures(2, 'error') === 3);
ok('failures reset on a decided cycle', nextConsecutiveFailures(4, 'decided') === 0);
ok('failures reset on a soft skip too', nextConsecutiveFailures(4, 'skip') === 0);

// Missed beats: count, never replay (one fresh cycle on the current market).
ok('missed: null prev → 0', missedBeats(null, NOW, 5) === 0);
ok('missed: claimed on time → 0', missedBeats(NOW, NOW, 5) === 0);
ok('missed: 23 min late, 5-min beat → 4', missedBeats(NOW - 23 * MIN, NOW, 5) === 4);

// Overheating streak: only a decided cycle touches it; ++ at the floor, reset above.
ok('floor streak increments at the 15-min floor', nextFloorStreak(2, 'decided', 15, 15) === 3);
ok('floor streak resets above the floor', nextFloorStreak(2, 'decided', 60, 15) === 0);
ok('floor streak untouched on skip', nextFloorStreak(2, 'skip', null, 15) === 2);
ok('floor streak untouched on error', nextFloorStreak(2, 'error', null, 15) === 2);

console.log(`\n${passed} scheduler checks passed.`);
