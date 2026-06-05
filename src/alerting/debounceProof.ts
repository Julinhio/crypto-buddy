import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { claimDueRun, finishRun } from '../persistence/schedulerState.js';
import { evaluateAlert } from '../scheduler/policy.js';
import { formatAlert, type AlertTrigger } from './messages.js';

/**
 * `npm run alerting:debounce-check` — QUASI-REAL proof of the alert debounce, per the
 * project's "prove it live, not just in code" discipline. It drives the REAL bot_state
 * through the REAL claim_due_run + finish_run SQL path against the actual Supabase, for
 * a scripted sequence of counter values, and asserts at each step that:
 *   - the alert fires EXACTLY ONCE on the crossing, stays silent while above, and
 *     re-arms once the counter drops back (then fires again on a re-cross);
 *   - the two triggers are INDEPENDENT — a standing degraded alert never masks a new
 *     overheating alert, and vice versa;
 *   - the debounce flags round-trip correctly through finish_run → DB → read-back.
 *
 * It does NOT send Telegram (it formats and prints what WOULD be sent) and does NOT run
 * a decision cycle (no LLM, no orders). It snapshots bot_state up front and restores it
 * at the end, so the scheduler is left exactly as it was. Safe to run now: the Railway
 * cron is not wired yet, so nothing races us on the singleton. It does append a few
 * tagged rows to scheduler_runs (the append-only audit table) — harmless test traces.
 */

const FLOOR_TH = config.alerting.floorStreakThreshold;
const FAIL_TH = config.alerting.consecutiveFailuresThreshold;

/** One scripted beat: the crafted counters and the fire we expect from each trigger. */
interface Step {
  label: string;
  floor: number;
  fail: number;
  expectFloorFire: boolean;
  expectFailFire: boolean;
}

// Thresholds are floor=10, fail=3 by default. The sequence exercises: climb without
// crossing, cross-once, silence-while-above, re-arm, re-cross — and independence in
// BOTH directions (one trigger crossing while the other is standing/below).
const SCENARIO: Step[] = [
  { label: 'both below threshold',                 floor: 2,           fail: 2,          expectFloorFire: false, expectFailFire: false },
  { label: 'degraded crosses (floor stays low)',   floor: 2,           fail: FAIL_TH,    expectFloorFire: false, expectFailFire: true  },
  { label: 'degraded stays above → silent',        floor: 2,           fail: FAIL_TH + 1, expectFloorFire: false, expectFailFire: false },
  { label: 'overheating crosses while degraded up', floor: FLOOR_TH,   fail: FAIL_TH + 1, expectFloorFire: true,  expectFailFire: false },
  { label: 'overheating up, degraded re-arms (0)',  floor: FLOOR_TH + 1, fail: 0,         expectFloorFire: false, expectFailFire: false },
  { label: 'floor re-arms (0), degraded re-crosses', floor: 0,         fail: FAIL_TH,    expectFloorFire: false, expectFailFire: true  },
  { label: 'overheating re-crosses, degraded re-arms', floor: FLOOR_TH, fail: 0,         expectFloorFire: true,  expectFailFire: false },
];

interface StateRow {
  next_check_at: string | null;
  run_token: string | null;
  locked_until: string | null;
  last_heartbeat_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  floor_delay_streak: number;
  floor_alert_sent: boolean;
  failure_alert_sent: boolean;
}

async function readState(supabase: SupabaseClient): Promise<StateRow> {
  const { data, error } = await supabase.from('bot_state').select('*').eq('id', 1).single();
  if (error) throw new Error(`read bot_state failed: ${error.message}`);
  return data as StateRow;
}

/**
 * Direct singleton write — the ONLY place the proof bypasses the SQL functions, used
 * purely to set up (reset to a known due/unlocked state) and tear down (restore the
 * snapshot). Legitimate here: the service-role key bypasses RLS, and no cron is live.
 */
async function writeState(supabase: SupabaseClient, patch: Partial<StateRow>): Promise<void> {
  const { error } = await supabase.from('bot_state').update(patch).eq('id', 1);
  if (error) throw new Error(`write bot_state failed: ${error.message}`);
}

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error(
      'alerting:debounce-check needs Supabase configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — ' +
        'this is a LIVE proof against the real DB.',
    );
    process.exit(1);
  }

  console.log(`Debounce live proof — thresholds: floor=${FLOOR_TH}, failures=${FAIL_TH}.`);
  const snapshot = await readState(supabase);
  console.log('bot_state snapshot taken (will be restored at the end).');

  try {
    // Reset to a clean, due, unlocked starting point (counters 0, flags re-armed).
    await writeState(supabase, {
      next_check_at: null,
      run_token: null,
      locked_until: null,
      consecutive_failures: 0,
      floor_delay_streak: 0,
      floor_alert_sent: false,
      failure_alert_sent: false,
    });

    for (const step of SCENARIO) {
      console.log(`\n• ${step.label} (floor=${step.floor}, failures=${step.fail})`);

      // Previous flags come from the DB — exactly what the heartbeat reads pre-cycle.
      const prev = await readState(supabase);
      const floorEval = evaluateAlert(step.floor, FLOOR_TH, prev.floor_alert_sent);
      const failEval = evaluateAlert(step.fail, FAIL_TH, prev.failure_alert_sent);

      ok(`overheating fire = ${step.expectFloorFire}`, floorEval.fire === step.expectFloorFire);
      ok(`degraded fire = ${step.expectFailFire}`, failEval.fire === step.expectFailFire);

      // Drive the REAL claim → finish path with the crafted counters + computed flags.
      const token = randomUUID();
      const claim = await claimDueRun(supabase, token, config.scheduler.lockTtlSeconds);
      ok('claimed the due run', claim !== null);
      if (!claim) break;

      const finalized = await finishRun(supabase, {
        runToken: token,
        runId: claim.runId,
        delayMinutes: 0, // next_check_at = now() → immediately due again for the next step
        consecutiveFailures: step.fail,
        floorDelayStreak: step.floor,
        succeeded: false,
        outcome: 'error',
        decisionId: null,
        missedBeats: 0,
        detail: `[debounce-proof] ${step.label}`,
        floorAlertSent: floorEval.sent,
        failureAlertSent: failEval.sent,
      });
      ok('finish_run held the lock and wrote state', finalized === true);

      // Round-trip: the flags + counters we computed must be exactly what landed.
      const after = await readState(supabase);
      ok('floor_delay_streak persisted', after.floor_delay_streak === step.floor);
      ok('consecutive_failures persisted', after.consecutive_failures === step.fail);
      ok('floor_alert_sent round-tripped', after.floor_alert_sent === floorEval.sent);
      ok('failure_alert_sent round-tripped', after.failure_alert_sent === failEval.sent);

      // Show the message that WOULD be sent (composition proof, without sending).
      const fired: { trigger: AlertTrigger; value: number; lastError?: string | null }[] = [];
      if (floorEval.fire) fired.push({ trigger: 'overheating', value: step.floor });
      if (failEval.fire) fired.push({ trigger: 'degraded', value: step.fail, lastError: `[debounce-proof] ${step.label}` });
      for (const f of fired) {
        console.log('  would send →');
        console.log(
          formatAlert({ ...f, timestamp: claim.dbNow })
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n'),
        );
      }
    }

    console.log(`\n${passed} debounce checks passed.`);
  } finally {
    // Always restore the scheduler exactly as we found it.
    await writeState(supabase, {
      next_check_at: snapshot.next_check_at,
      run_token: snapshot.run_token,
      locked_until: snapshot.locked_until,
      last_success_at: snapshot.last_success_at,
      consecutive_failures: snapshot.consecutive_failures,
      floor_delay_streak: snapshot.floor_delay_streak,
      floor_alert_sent: snapshot.floor_alert_sent,
      failure_alert_sent: snapshot.failure_alert_sent,
    });
    console.log('bot_state snapshot restored.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('debounce-check failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
