import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
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
  evaluateAlert,
  type CycleStatus,
} from '../scheduler/policy.js';
import { formatAlert } from '../alerting/messages.js';
import {
  recordHeartbeat,
  claimDueRun,
  finishRun,
  claimManualRun,
  releaseManualRun,
  type FinishRunParams,
} from '../persistence/schedulerState.js';
import { runHeartbeat } from '../scheduler/heartbeat.js';
import { runCycleWithTimeout, runGuardedCycle } from '../scheduler/cycleGuard.js';
import type { DecideResult } from '../decision/decide.js';

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

// ── Alert debounce (pure): fire ONCE on the crossing, silent while above, re-arm
//    below; the two triggers are independent. The LIVE DB round-trip + independence
//    is proven by `npm run alerting:debounce-check`; this is the offline logic. ──
console.log('\nAlert debounce (per-trigger anti-spam):');
ok('no fire below threshold', evaluateAlert(2, 3, false).fire === false);
ok('flag stays re-armed below threshold', evaluateAlert(2, 3, false).sent === false);
ok('fires on the crossing (not yet sent)', evaluateAlert(3, 3, false).fire === true);
ok('arms the flag on the crossing', evaluateAlert(3, 3, false).sent === true);
ok('silent while above (already sent)', evaluateAlert(4, 3, true).fire === false);
ok('flag stays armed while above', evaluateAlert(4, 3, true).sent === true);
ok('no fire on the re-arming beat', evaluateAlert(0, 3, true).fire === false);
ok('re-arms when it drops back to 0', evaluateAlert(0, 3, true).sent === false);
ok('fires again on a re-cross after re-arm', evaluateAlert(3, 3, false).fire === true);

// ── Alert message: names the trigger + counter value + timestamp; the last error
//    rides only on the degraded alert, and a huge error is truncated. ──
console.log('\nAlert message formatting:');
const ats = '2026-06-05T17:30:00.000Z';
const heat = formatAlert({ trigger: 'overheating', value: 10, timestamp: ats });
ok('overheating carries trigger + value + timestamp', heat.includes('EMBALLEMENT') && heat.includes('floor_delay_streak = 10') && heat.includes(ats));
ok('overheating has no error line', !heat.includes('Dernière erreur'));
const degr = formatAlert({ trigger: 'degraded', value: 3, timestamp: ats, lastError: 'cycle threw: kaboom' });
ok('degraded carries trigger + value + timestamp', degr.includes('DÉGRADÉ') && degr.includes('consecutive_failures = 3') && degr.includes(ats));
ok('degraded includes the last error when present', degr.includes('kaboom'));
ok('degraded states unavailable when no error', formatAlert({ trigger: 'degraded', value: 3, timestamp: ats, lastError: null }).includes('non disponible'));
ok('degraded truncates a huge error', formatAlert({ trigger: 'degraded', value: 3, timestamp: ats, lastError: 'x'.repeat(2000) }).includes('[truncated]'));

// ── Error propagation: an infra fault must THROW (→ non-zero exit), while a genuine
//    business result stays null/false. (No real network — a fake rpc() client.) ──
console.log('\nScheduler infra-error propagation (cron monitoring depends on the exit code):');

const rpc = (data: unknown, error: unknown = null): SupabaseClient =>
  ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;
const rpcError = (): SupabaseClient => rpc(null, { message: 'db down' });

async function okThrows(label: string, p: Promise<unknown>): Promise<void> {
  await assert.rejects(p);
  console.log(`  ok: ${label}`);
  passed += 1;
}
async function okResolves(label: string, p: Promise<unknown>, expected: unknown): Promise<void> {
  assert.deepEqual(await p, expected);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const fp: FinishRunParams = {
  runToken: 'tok', runId: 1, delayMinutes: 30, consecutiveFailures: 0, floorDelayStreak: 0,
  succeeded: true, outcome: 'decided', decisionId: null, missedBeats: 0, detail: null,
  floorAlertSent: false, failureAlertSent: false,
};
const claimRow = { run_id: 7, prev_next_check_at: null, db_now: '2024-01-01T00:00:00Z', consecutive_failures: 1, floor_delay_streak: 2 };

// recordHeartbeat: throws on RPC error and on a missing singleton; ok otherwise.
await okThrows('recordHeartbeat throws on an RPC error', recordHeartbeat(rpcError()));
await okThrows('recordHeartbeat throws on a missing bot_state row', recordHeartbeat(rpc(null)));

// claimDueRun: throws on RPC error; null ONLY when the RPC ran but didn't claim.
await okThrows('claimDueRun throws on an RPC error', claimDueRun(rpcError(), 'tok', 600));
await okResolves('claimDueRun → null only when not claimed (not due / locked)', claimDueRun(rpc([]), 'tok', 600), null);
ok('claimDueRun maps a claimed row', (await claimDueRun(rpc([claimRow]), 'tok', 600))?.runId === 7);

// finishRun: throws on RPC error; true/false are the real results (false = fencing).
await okThrows('finishRun throws on an RPC error', finishRun(rpcError(), fp));
await okResolves('finishRun → true when the RPC reports success', finishRun(rpc(true), fp), true);
await okResolves('finishRun → false ONLY for the fencing case', finishRun(rpc(false), fp), false);

// claim_manual_run / release_manual_run: throw on RPC error; the boolean is the result
// (claimed / busy, released / reclaimed). The manual entrypoint routes through these
// so it honors the SAME lock as the beat and the reset.
await okThrows('claimManualRun throws on an RPC error', claimManualRun(rpcError(), 'tok', 600));
await okResolves('claimManualRun → true when the lock is claimed', claimManualRun(rpc(true), 'tok', 600), true);
await okResolves('claimManualRun → false when a live lock is held (busy)', claimManualRun(rpc(false), 'tok', 600), false);
await okThrows('releaseManualRun throws on an RPC error', releaseManualRun(rpcError(), 'tok'));
await okResolves('releaseManualRun → true when we still held the lock', releaseManualRun(rpc(true), 'tok'), true);
await okResolves('releaseManualRun → false when the lock was reclaimed (fencing)', releaseManualRun(rpc(false), 'tok'), false);

// Orchestrator: an unconfigured Supabase client is a config error → throw, not no-op.
await okThrows('runHeartbeat throws when Supabase is unconfigured', runHeartbeat({ supabase: null }));

// ── Hard cycle timeout: bounds decide() under maxCycleSeconds → technical error → backoff ──
console.log('\nScheduler cycle timeout (the catch-all that keeps the lock from expiring mid-cycle):');

const fakeResult = (status: CycleStatus, appliedDelay: number | null): DecideResult =>
  ({ status, decisionId: null, row: { applied_delay_minutes: appliedDelay } }) as unknown as DecideResult;

const fast = await runCycleWithTimeout(() => Promise.resolve(fakeResult('decided', 60)), 1000);
ok('a cycle within budget keeps its real status', fast.status === 'decided' && fast.appliedDelayMinutes === 60);

const slow = await runCycleWithTimeout(
  () => new Promise<DecideResult>((r) => setTimeout(() => r(fakeResult('decided', 60)), 40)),
  5,
);
ok('a cycle OVER budget becomes a technical error', slow.status === 'error');
ok(
  'a timed-out cycle drives the backoff path',
  classifyOutcome(slow.status) === 'error' &&
    backoffMinutes(nextConsecutiveFailures(0, classifyOutcome(slow.status)), 15, 240) === 15,
);

const threw = await runCycleWithTimeout(() => Promise.reject(new Error('kaboom')), 1000);
ok('a thrown cycle is a technical error with the stack captured', threw.status === 'error' && threw.detail.includes('kaboom'));

// ── Guarded cycle: SETTLED detection — the bit that drives keep-vs-release the lock ──
console.log('\nGuarded cycle — settled detection (returned/threw = no orphan; timeout = orphan):');
const gReturned = await runGuardedCycle(() => Promise.resolve(fakeResult('decided', 60)), 1000);
ok('a returned cycle is SETTLED (safe to finalize)', gReturned.settled === true && gReturned.outcome.status === 'decided' && gReturned.result !== null);
const gThrew = await runGuardedCycle(() => Promise.reject(new Error('boom')), 1000);
ok('a thrown cycle is SETTLED — no orphan → release, don\'t block a full TTL', gThrew.settled === true && gThrew.outcome.status === 'error' && gThrew.result === null);
const gTimedOut = await runGuardedCycle(
  () => new Promise<DecideResult>((r) => setTimeout(() => r(fakeResult('decided', 60)), 40)),
  5,
);
ok('a TIMED-OUT cycle is NOT settled (orphan still running) → must KEEP the lock', gTimedOut.settled === false && gTimedOut.outcome.status === 'error' && gTimedOut.result === null);

// ── runHeartbeat watchdog branch: a TIMED-OUT cycle keeps the lock (no finish_run);
//    a SETTLED one finalizes (finish_run). A dispatching fake client records the RPCs
//    so we can assert finish_run is/ isn't called — the load-bearing behavior change. ──
console.log('\nrunHeartbeat watchdog branch (timeout keeps the lock; settled finalizes):');

function dispatchClient(calls: string[]): SupabaseClient {
  return {
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === 'record_heartbeat') {
        // due (next_check in the past) + unlocked → claimable
        return {
          data: [{
            next_check_at: new Date(NOW - MIN).toISOString(), run_token: null, locked_until: null,
            last_heartbeat_at: new Date(NOW).toISOString(), last_success_at: null,
            consecutive_failures: 0, floor_delay_streak: 0, floor_alert_sent: false, failure_alert_sent: false,
          }],
          error: null,
        };
      }
      if (fn === 'claim_due_run') {
        return { data: [{ run_id: 1, prev_next_check_at: null, db_now: new Date(NOW).toISOString(), consecutive_failures: 0, floor_delay_streak: 0 }], error: null };
      }
      if (fn === 'finish_run') return { data: true, error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const timedOutCycle = async () => ({
  outcome: { status: 'error' as const, appliedDelayMinutes: null, decisionId: null, detail: 'frozen', equitySnapshot: null },
  settled: false, result: null,
});
const settledThrow = async () => ({
  outcome: { status: 'error' as const, appliedDelayMinutes: null, decisionId: null, detail: 'threw', equitySnapshot: null },
  settled: true, result: null,
});

{
  const calls: string[] = [];
  const res = await runHeartbeat({ supabase: dispatchClient(calls), runCycle: timedOutCycle });
  ok('timeout → action=timed-out', res.action === 'timed-out');
  ok('timeout → finish_run is NEVER called (lock KEPT, no reschedule)', !calls.includes('finish_run'));
}
{
  const calls: string[] = [];
  const res = await runHeartbeat({ supabase: dispatchClient(calls), runCycle: settledThrow });
  ok('settled (throw) → action=ran', res.action === 'ran');
  ok('settled → finish_run IS called (release + reschedule + close)', calls.includes('finish_run'));
}

console.log(`\n${passed} scheduler checks passed.`);
