import assert from 'node:assert/strict';
import { config } from '../config/index.js';
import { evaluateAlert, evaluateRecovery, nextBlindCycles } from '../scheduler/policy.js';
import { formatAlert } from '../alerting/messages.js';
import {
  blindBlocks,
  incidentCycles,
  WINDOW,
  WINDOW_CYCLES,
  type WindowCycle,
} from './marketDataOutageWindow.js';

/**
 * `npx tsx src/replay/marketDataAlerts.ts` — REPLAY OF THE REAL 09/08 SEQUENCE.
 *
 * The question this answers is the brief's: on the actual band, at which cycles would the
 * "données de marché indisponibles" alert have fired, and how many messages in total?
 *
 * It is a replay, not a simulation. The three functions driving it —
 * `nextBlindCycles`, `evaluateAlert`, `evaluateRecovery` — are the EXACT ones the
 * heartbeat calls in production, imported from `scheduler/policy.ts`, and the threshold is
 * read from the live `config.alerting.blindCyclesThreshold`. Nothing here re-implements
 * the logic under test, so a change to the debounce shows up here rather than being
 * quietly reproduced by a copy.
 *
 * The band itself is frozen (see marketDataOutageWindow.ts): the bot is running and
 * writing, so re-querying would make this proof drift off the incident it is about.
 */

const TH = config.alerting.blindCyclesThreshold;

interface Fired {
  kind: 'alert' | 'recovery';
  runId: number;
  at: string;
  /** consecutive_blind_cycles at the moment it fired. */
  value: number;
}

/**
 * Drives the real state machine over a sequence, exactly as the heartbeat does: read the
 * previous counter + flag, compute the new counter, evaluate both crossings, persist.
 */
function replay(cycles: WindowCycle[]): { fired: Fired[]; finalCounter: number } {
  let counter = 0;
  let sent = false;
  const fired: Fired[] = [];

  for (const c of cycles) {
    const prevCounter = counter;
    const prevSent = sent;

    // Exactly the heartbeat's three lines.
    counter = nextBlindCycles(prevCounter, c.blind ? 'blind' : 'sighted');
    const alert = evaluateAlert(counter, TH, prevSent);
    const recovered = evaluateRecovery(counter, TH, prevSent);
    sent = alert.sent;

    if (alert.fire) fired.push({ kind: 'alert', runId: c.runId, at: c.at, value: counter });
    // The recovery reports the streak that just ENDED, which is the pre-cycle counter.
    if (recovered) fired.push({ kind: 'recovery', runId: c.runId, at: c.at, value: prevCounter });
  }

  return { fired, finalCounter: counter };
}

function main(): void {
  const incident = incidentCycles();
  const blind = incident.filter((c) => c.blind);

  console.log('═'.repeat(92));
  console.log('REPLAY — "données de marché indisponibles" over the real 09/08 outage');
  console.log('═'.repeat(92));
  console.log(`window (frozen)   : ${WINDOW.incidentFromIso} → ${WINDOW.incidentToIso}`);
  console.log(`cycles in window  : ${incident.length}  (bracketed table holds ${WINDOW_CYCLES.length})`);
  console.log(`blind cycles      : ${blind.length}`);
  console.log(`consecutive blocks: ${blindBlocks().join(', ')}`);
  console.log(`threshold         : ${TH} consecutive blind cycles (config.alerting.blindCyclesThreshold)`);
  console.log('');

  const { fired, finalCounter } = replay(incident);

  // ── the per-cycle trace ───────────────────────────────────────────────────────────
  console.log('─'.repeat(92));
  console.log('run    when (UTC)          data      blind_streak   message');
  console.log('─'.repeat(92));
  {
    let counter = 0;
    let sent = false;
    for (const c of incident) {
      const prevCounter = counter;
      const prevSent = sent;
      counter = nextBlindCycles(prevCounter, c.blind ? 'blind' : 'sighted');
      const alert = evaluateAlert(counter, TH, prevSent);
      const recovered = evaluateRecovery(counter, TH, prevSent);
      sent = alert.sent;

      const marker = alert.fire
        ? '🔔 ALERT   « données de marché indisponibles »'
        : recovered
          ? `✅ RECOVERY (outage lasted ${prevCounter} cycles)`
          : '';
      // Only print the cycles that matter: every message, plus the run-up to each one.
      const interesting = marker !== '' || (c.blind && counter <= TH) || !c.blind;
      if (interesting) {
        console.log(
          `${String(c.runId).padEnd(6)} ${c.at.replace('T', ' ').replace('Z', '').padEnd(20)} ` +
            `${(c.blind ? 'BLIND' : 'ok').padEnd(9)} ${String(counter).padEnd(14)} ${marker}`,
        );
      }
    }
  }
  console.log('─'.repeat(92));
  console.log('(silent blind cycles between an alert and its recovery are omitted — that silence IS the debounce)');
  console.log('');

  // ── the counts the brief asks for, separately ─────────────────────────────────────
  const alerts = fired.filter((f) => f.kind === 'alert');
  const recoveries = fired.filter((f) => f.kind === 'recovery');

  console.log('═'.repeat(92));
  console.log('TOTALS');
  console.log('═'.repeat(92));
  console.log(`alerts      : ${alerts.length}   ${alerts.map((a) => `#${a.runId} @${a.at}`).join('  ')}`);
  console.log(`recoveries  : ${recoveries.length}   ${recoveries.map((r) => `#${r.runId} @${r.at}`).join('  ')}`);
  console.log(`messages    : ${fired.length} in total over ${WINDOW.incidentFromIso} → ${WINDOW.incidentToIso}`);
  console.log('');
  console.log(`Without the debounce, the same band would have sent ${blind.length} messages (one per blind wake-up).`);
  console.log('');

  // ── one full message, so the wording is reviewed and not just counted ─────────────
  const first = alerts[0];
  if (first) {
    console.log('─'.repeat(92));
    console.log('The first alert, as it would have arrived on Telegram:');
    console.log('─'.repeat(92));
    console.log(
      formatAlert({
        trigger: 'market_data',
        value: first.value,
        timestamp: first.at,
        cause: 'ExchangeNotAvailable / HTTP 451 / api.binance.com/api/v3/klines (illustrative — ' +
          'the real cause is whatever market_data_incidents captured that cycle)',
      }),
    );
    console.log('');
  }

  // ── assertions: the brief's stated expectation, checked ───────────────────────────
  console.log('═'.repeat(92));
  console.log('EXPECTATION (brief §2): three alerts, one per prolonged block, nothing on the isolated 03:55');
  console.log('═'.repeat(92));

  const checks: [string, boolean, string][] = [
    ['exactly 3 alerts', alerts.length === 3, `got ${alerts.length}`],
    [
      'nothing fired on the isolated 03:55 failure (block of 1)',
      !fired.some((f) => f.runId === 1186),
      '',
    ],
    [
      'one alert per prolonged block (4, 22, 4) — fired on the 3rd blind cycle of each',
      alerts.length === 3 &&
        alerts[0]?.runId === 1193 &&
        alerts[1]?.runId === 1198 &&
        alerts[2]?.runId === 1221,
      alerts.map((a) => `#${a.runId}`).join(','),
    ],
    ['every alert fired at exactly the threshold value', alerts.every((a) => a.value === TH), ''],
    ['3 recoveries — one closing each alert', recoveries.length === 3, `got ${recoveries.length}`],
    [
      'the recoveries report the real block lengths (4, 22, 4)',
      JSON.stringify(recoveries.map((r) => r.value)) === JSON.stringify([4, 22, 4]),
      JSON.stringify(recoveries.map((r) => r.value)),
    ],
    ['6 messages in total (3 alerts + 3 recoveries), not 31', fired.length === 6, `got ${fired.length}`],
    ['the window ends with the counter re-armed at 0', finalCounter === 0, `got ${finalCounter}`],
  ];

  let failed = 0;
  for (const [label, condition, detail] of checks) {
    if (condition) console.log(`  PASS  ${label}`);
    else {
      failed += 1;
      console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
  }

  console.log('');
  console.log('═'.repeat(92));
  console.log(
    failed === 0
      ? `${checks.length}/${checks.length} — the threshold of 3 produces exactly three alerts on the real sequence.`
      : `${checks.length - failed}/${checks.length} — MISMATCH. Do NOT retune the threshold to make this pass; report it.`,
  );
  console.log('═'.repeat(92));

  assert.equal(failed, 0, `${failed} expectation(s) not met`);
}

main();
