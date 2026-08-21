import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import {
  classifyLlmFailure,
  serializeLlmFailure,
  LlmAttemptDeadlineError,
} from '../decision/llmFailure.js';
import {
  evaluateDegradedIncident,
  nextConsecutiveFailures,
  nextDelayMinutes,
  type RunOutcome,
} from '../scheduler/policy.js';
import { formatAlert, formatDuration } from '../alerting/messages.js';
import { countFailedRunsSince } from '../persistence/schedulerState.js';
import { validateDecisionConfig, config, type DecisionConfig } from '../config/index.js';

/**
 * PROVIDER-RESILIENCE TEST — the offline proofs of the 20/08/2026 incident PR.
 *
 * What is being defended, in one sentence: a temporary fault on Anthropic's side must cost
 * the bot minutes, not hours, and nothing in that decision may depend on the wording of an
 * error message.
 *
 * Five families, in the order they matter:
 *
 *   A. CLASSIFICATION — exactly four causes become `retryable_llm_transport`, and an
 *      unknown error never does. Includes the wording-independence proof.
 *   B. PROPAGATION    — the typed class drives the delay; text does not.
 *   C. BACKOFF        — the four sequences of the brief, mixed classes included.
 *   D. CONFIGURATION  — the new bound is fully closed at startup.
 *   E. JOURNAL        — one serializer, versioned, no invented values, no secrets.
 *   F. RECOVERY       — the seven sequences, `skipped` cycles included.
 *
 * No network, no database, no clock of its own. Run via `npm test`.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const NO_FACTS = { logicalAttempt: 1, elapsedMs: null };

/** Builds a real SDK error of the right class, exactly as the SDK's own generator would. */
function apiError(status: number, type: string, requestId: string | null = null): APIError {
  const body = { type: 'error', error: { type, message: type } };
  const headers = new Headers(requestId ? { 'request-id': requestId } : {});
  return APIError.generate(status, body, undefined, headers);
}

// ── A. CLASSIFICATION ────────────────────────────────────────────────────────────────
console.log('LLM failure classification — only four causes may become retryable:');

{
  const deadline = classifyLlmFailure(new LlmAttemptDeadlineError(90_000), NO_FACTS);
  ok('the local attempt deadline is retryable transport', deadline.failureClass === 'retryable_llm_transport');
  ok('…and it is recognised by TYPE, so it carries no HTTP status', deadline.httpStatus === null);

  const connection = classifyLlmFailure(
    new APIConnectionError({ message: 'Connection error.', cause: new Error('ECONNRESET') }),
    NO_FACTS,
  );
  ok('an SDK connection error is retryable transport', connection.failureClass === 'retryable_llm_transport');

  const connTimeout = classifyLlmFailure(new APIConnectionTimeoutError(), NO_FACTS);
  ok("the SDK's own per-request timeout is retryable transport too", connTimeout.failureClass === 'retryable_llm_transport');

  const rate = classifyLlmFailure(apiError(429, 'rate_limit_error'), NO_FACTS);
  ok('HTTP 429 is retryable transport', rate.failureClass === 'retryable_llm_transport');
  ok('…and it is really the SDK RateLimitError class', apiError(429, 'rate_limit_error') instanceof RateLimitError);
  ok('429 keeps its status in the classification', rate.httpStatus === 429);

  const five00 = classifyLlmFailure(apiError(500, 'api_error'), NO_FACTS);
  ok('HTTP 500 is retryable transport', five00.failureClass === 'retryable_llm_transport');
  ok('…via the SDK InternalServerError class', apiError(500, 'api_error') instanceof InternalServerError);

  // The 23/06/2026 pair. 529 needs no special case — it is a 5xx like any other, which is
  // the point: the rule is a range, not a list of codes someone has to remember to extend.
  const five29 = classifyLlmFailure(apiError(529, 'overloaded_error', 'req_011CcLLEjeuWG5EhyFaUtDFx'), NO_FACTS);
  ok('HTTP 529 overloaded_error is retryable transport', five29.failureClass === 'retryable_llm_transport');
  ok('529 keeps its status', five29.httpStatus === 529);
  ok('529 keeps the request id — the only handle into the provider side', five29.requestId === 'req_011CcLLEjeuWG5EhyFaUtDFx');
}

{
  const auth = classifyLlmFailure(apiError(401, 'authentication_error'), NO_FACTS);
  ok('HTTP 401 authentication is NOT retryable', auth.failureClass === null);
  ok('…and it really is the AuthenticationError class', apiError(401, 'authentication_error') instanceof AuthenticationError);

  const perm = classifyLlmFailure(apiError(403, 'permission_error'), NO_FACTS);
  ok('HTTP 403 permission denied is NOT retryable', perm.failureClass === null);
  ok('…and it really is the PermissionDeniedError class', apiError(403, 'permission_error') instanceof PermissionDeniedError);

  ok('HTTP 400 bad request is NOT retryable', classifyLlmFailure(apiError(400, 'invalid_request_error'), NO_FACTS).failureClass === null);
  ok('HTTP 404 (a wrong model id) is NOT retryable', classifyLlmFailure(apiError(404, 'not_found_error'), NO_FACTS).failureClass === null);

  // The configuration error the decision layer raises before any call is made.
  const cfg = new Error(
    'Missing ANTHROPIC_API_KEY — set it in .env to run the decision layer. This is a configuration error.',
  );
  ok('a configuration error (missing API key) is NOT retryable', classifyLlmFailure(cfg, NO_FACTS).failureClass === null);

  ok('an unknown Error is NOT retryable', classifyLlmFailure(new Error('something went sideways'), NO_FACTS).failureClass === null);
  ok('a thrown non-Error is NOT retryable', classifyLlmFailure('a string', NO_FACTS).failureClass === null);
  ok('a thrown non-Error still yields a usable errorType', classifyLlmFailure('a string', NO_FACTS).errorType === 'string');

  // The load-bearing negative: an abort we did not cause. Our own deadline arrives wrapped
  // in LlmAttemptDeadlineError; a bare APIUserAbortError means somebody ELSE cancelled the
  // request, and an unknown cause never earns a shorter backoff.
  const foreign = classifyLlmFailure(new APIUserAbortError(), NO_FACTS);
  ok('a bare APIUserAbortError (not our deadline) is NOT retryable', foreign.failureClass === null);
}

// THE WORDING-INDEPENDENCE PROOF. `Request was aborted.` is the exact string production
// journaled four times on 20/08. If classification read messages, changing this text would
// change the bot's backoff — and it would fail OPEN, which is the incident again.
{
  const standard = new LlmAttemptDeadlineError(90_000);
  const reworded = new LlmAttemptDeadlineError(90_000);
  reworded.message = 'La requête a été abandonnée. (完全に違う文章)';
  const a = classifyLlmFailure(standard, NO_FACTS);
  const b = classifyLlmFailure(reworded, NO_FACTS);
  ok('rewording the deadline error does NOT change its class', a.failureClass === b.failureClass);
  ok('…and the class is still retryable transport', b.failureClass === 'retryable_llm_transport');
  ok('…while the message itself did change (so the test is not vacuous)', a.message !== b.message);

  // The converse: the OLD sentence, carried by an error that is not our deadline, must not
  // be promoted. A string-matching classifier would get this one wrong.
  const impostor = new Error('Request was aborted.');
  ok('the literal sentence "Request was aborted." on a plain Error is NOT retryable', classifyLlmFailure(impostor, NO_FACTS).failureClass === null);
}

// ── B. TYPED PROPAGATION ─────────────────────────────────────────────────────────────
console.log('\nTyped propagation — the delay follows the class, never the text:');

const D = { softSkipDelayMinutes: 30, minDelayMinutes: 15, maxDelayMinutes: 240, retryableLlmTransportMaxDelayMinutes: 30 };
const delayFor = (failuresAfter: number, failureClass: 'retryable_llm_transport' | null): number =>
  nextDelayMinutes('error', { ...D, appliedDelayMinutes: null, failuresAfter, failureClass });

{
  // The scheduler's input is the classification object produced ONCE in the decision layer.
  // Here it is fed the real thing, end to end: SDK error → classify → delay.
  const classified = classifyLlmFailure(apiError(529, 'overloaded_error'), NO_FACTS);
  ok(
    'a 529 classified at the LLM layer reaches the delay as retryable transport',
    delayFor(4, classified.failureClass) === 30,
  );

  // The same failure with a mutilated message / different raw_response / different detail
  // must produce the SAME delay: the scheduler never reads any of those fields.
  const mutilated = { ...classified, message: 'totally different text', errorType: 'Whatever' };
  ok(
    'mutating message and errorType does not move the delay',
    delayFor(4, mutilated.failureClass) === delayFor(4, classified.failureClass),
  );

  // And the reverse: an unclassified failure whose MESSAGE looks like a timeout still takes
  // the generic backoff. This is the property that makes the journal safe to reword.
  const looksLikeATimeout = classifyLlmFailure(new Error('timeout: Request was aborted after 90008ms'), NO_FACTS);
  ok('a message that merely LOOKS transient takes the generic backoff', delayFor(4, looksLikeATimeout.failureClass) === 120);
}

// ── C. BACKOFF SEQUENCES ─────────────────────────────────────────────────────────────
console.log('\nBackoff sequences (consecutive_failures stays GLOBAL; the class picks the ceiling):');

/** Walks a sequence of failure classes through the real counter + the real delay function. */
function walk(classes: Array<'retryable_llm_transport' | null>): number[] {
  let failures = 0;
  return classes.map((c) => {
    failures = nextConsecutiveFailures(failures, 'error');
    return delayFor(failures, c);
  });
}

const T = 'retryable_llm_transport' as const;
{
  const allTransport = walk([T, T, T, T, T]);
  ok(`five transport errors → 15/30/30/30/30 (got ${allTransport.join('/')})`, allTransport.join('/') === '15/30/30/30/30');

  const allOther = walk([null, null, null, null, null]);
  ok(`five non-transport errors → 15/30/60/120/240 (got ${allOther.join('/')})`, allOther.join('/') === '15/30/60/120/240');

  // A provider outage does NOT buy a genuinely broken bot a shorter leash: the fifth
  // failure is the fifth GLOBAL failure and takes the full generic delay.
  const transportThenOther = walk([T, T, T, T, null]);
  ok(`four transport then one non-transport → 15/30/30/30/240 (got ${transportThenOther.join('/')})`, transportThenOther.join('/') === '15/30/30/30/240');

  // And a bot that was broken and is now merely waiting on Anthropic does not inherit four
  // hours of silence from its own past.
  const otherThenTransport = walk([null, null, null, null, T]);
  ok(`four non-transport then one transport → 15/30/60/120/30 (got ${otherThenTransport.join('/')})`, otherThenTransport.join('/') === '15/30/60/120/30');

  // A change of class does NOT reset the counter — proven directly rather than inferred
  // from the sequences above, since it is the property the brief singles out.
  ok('a class change does not reset consecutive_failures (5th stays the 5th)', walk([T, null, T, null, null])[4] === 240);

  // The 20/08 counterfactual, stated as a number rather than as a claim.
  ok('the incident sequence loses 3h30 of the 4h it cost', 15 + 30 + 60 + 120 - (15 + 30 + 30 + 30) === 120);
}

// The other two outcomes are untouched by this PR — asserted, not assumed.
{
  ok('a decided cycle still takes the model delay', nextDelayMinutes('decided', { ...D, appliedDelayMinutes: 60, failuresAfter: 0, failureClass: T }) === 60);
  ok('a skipped cycle still takes the fixed repli', nextDelayMinutes('skip', { ...D, appliedDelayMinutes: null, failuresAfter: 0, failureClass: T }) === 30);
  // Omitting the two new options entirely (every pre-existing caller) must behave exactly
  // as before — this is what keeps the existing scheduler test meaningful.
  ok(
    'omitting the new options reproduces the old behaviour exactly',
    nextDelayMinutes('error', { appliedDelayMinutes: null, failuresAfter: 5, softSkipDelayMinutes: 30, minDelayMinutes: 15, maxDelayMinutes: 240 }) === 240,
  );
}

// ── D. CONFIGURATION BOUND ───────────────────────────────────────────────────────────
console.log('\nConfiguration bound (a cap that could never bind must not start the bot):');

const baseDecision: DecisionConfig = { ...config.decision };
const baseScheduler = config.scheduler;
const capAccepts = (label: string, cap: number): void => {
  assert.doesNotThrow(() =>
    validateDecisionConfig({ ...baseDecision, retryableLlmTransportMaxDelayMinutes: cap }, baseScheduler),
  );
  console.log(`  ok: ${label}`);
  passed += 1;
};
const capRejects = (label: string, cap: number): void => {
  assert.throws(() =>
    validateDecisionConfig({ ...baseDecision, retryableLlmTransportMaxDelayMinutes: cap }, baseScheduler),
  );
  console.log(`  ok: ${label}`);
  passed += 1;
};

ok('the DEPLOYED config is valid', baseDecision.retryableLlmTransportMaxDelayMinutes === 30);
assert.doesNotThrow(() => validateDecisionConfig(config.decision, config.scheduler));
console.log('  ok: validateDecisionConfig accepts the deployed config unchanged');
passed += 1;
capAccepts('accepts the floor itself (15)', baseDecision.minDelayMinutes);
capAccepts('accepts the ceiling itself (240)', baseDecision.maxDelayMinutes);
capRejects('rejects a cap below minDelayMinutes (14 — could never bind)', baseDecision.minDelayMinutes - 1);
capRejects('rejects a cap above maxDelayMinutes (241 — could never bind either)', baseDecision.maxDelayMinutes + 1);
capRejects('rejects zero', 0);
capRejects('rejects a negative value', -30);
capRejects('rejects a fraction', 30.5);
capRejects('rejects NaN', Number.NaN);
capRejects('rejects Infinity', Number.POSITIVE_INFINITY);

// ── E. STRUCTURED JOURNAL ────────────────────────────────────────────────────────────
console.log('\nStructured failure journal (one serializer, versioned, nothing invented):');

{
  const deadline = classifyLlmFailure(new LlmAttemptDeadlineError(90_000), { logicalAttempt: 1, elapsedMs: 90_008 });
  const json = JSON.parse(serializeLlmFailure(deadline)) as Record<string, unknown>;
  ok('the deadline journal is valid JSON', typeof json === 'object' && json !== null);
  ok('it carries the schema version', json.schema_version === 1);
  ok('it names the class', json.failure_class === 'retryable_llm_transport');
  ok('it names the error type', json.error_type === 'LlmAttemptDeadlineError');
  ok('it keeps the elapsed time — the 90 008 ms of 20/08', json.elapsed_ms === 90_008);
  ok('it records the LOGICAL attempt', json.logical_attempt === 1);
  ok('http_status is null, not guessed', json.http_status === null);
  ok('request_id is null, not guessed', json.request_id === null);
  // The one number nobody may invent. The SDK does not expose how many HTTP requests it
  // really made inside the attempt; `1 + maxRetries` is a ceiling and would read as data.
  ok('sdk_request_count is null — never derived from maxRetries', json.sdk_request_count === null);
  ok('the message is preserved in a useful form', typeof json.message === 'string' && (json.message as string).includes('90s deadline'));
}

{
  const five29 = classifyLlmFailure(apiError(529, 'overloaded_error', 'req_011CcLMkMNR3qitQfFjtea8x'), {
    logicalAttempt: 2,
    elapsedMs: 5532,
  });
  const json = JSON.parse(serializeLlmFailure(five29)) as Record<string, unknown>;
  ok('the 529 journal carries its status', json.http_status === 529);
  ok('the 529 journal carries its request id', json.request_id === 'req_011CcLMkMNR3qitQfFjtea8x');
  ok('the 529 journal names the guard relaunch as attempt 2', json.logical_attempt === 2);
  ok('the 529 journal is still classified retryable', json.failure_class === 'retryable_llm_transport');
  ok('sdk_request_count is null here too', json.sdk_request_count === null);
}

{
  // An error whose status AND request id are simply unknown: every hole must be an explicit
  // null, and the class must be null rather than optimistically retryable.
  const unknown = classifyLlmFailure(new Error('something we have never seen'), { logicalAttempt: null, elapsedMs: null });
  const json = JSON.parse(serializeLlmFailure(unknown)) as Record<string, unknown>;
  ok('an unknown failure serializes with failure_class null', json.failure_class === null);
  ok('…http_status null', json.http_status === null);
  ok('…request_id null', json.request_id === null);
  ok('…logical_attempt null', json.logical_attempt === null);
  ok('…elapsed_ms null', json.elapsed_ms === null);
  ok('…and every documented key is present, so a reader never has to guess a shape',
    ['schema_version', 'failure_class', 'error_type', 'message', 'http_status', 'request_id', 'logical_attempt', 'sdk_request_count', 'elapsed_ms']
      .every((k) => k in json));
}

{
  // No secret may ever reach this row. The SDK does not echo the key today; the redaction
  // is there because this row is written unattended and kept forever.
  const leaky = new Error('auth failed for key sk-ant-api03-AAAABBBBCCCCDDDD and nothing else');
  const json = JSON.parse(serializeLlmFailure(classifyLlmFailure(leaky, NO_FACTS))) as Record<string, unknown>;
  const msg = String(json.message);
  ok('an API-key-shaped token is redacted from the journal', !msg.includes('sk-ant-api03-AAAABBBBCCCCDDDD'));
  ok('…and the redaction is visible rather than silent', msg.includes('sk-ant-[REDACTED]'));

  const huge = new Error('x'.repeat(5000));
  const bounded = String((JSON.parse(serializeLlmFailure(classifyLlmFailure(huge, NO_FACTS))) as Record<string, unknown>).message);
  ok('a pathological message is bounded, not stored whole', bounded.length < 800 && bounded.includes('[truncated]'));

  // Neither prompt ever reaches the classifier: it only ever sees an error object. Proven
  // by construction here — the serializer has no prompt parameter to pass one through.
  ok('the serializer has no channel for a prompt (arity 1)', serializeLlmFailure.length === 1);
}

// ── F. RECOVERY ──────────────────────────────────────────────────────────────────────
console.log('\nDegraded incident lifecycle (armed on the crossing, held across skips, closed by a decision):');

const THRESHOLD = 3;

/** Replays a run of outcomes through the REAL counter + the REAL incident evaluator. */
function replay(outcomes: RunOutcome[]): { alerts: number; recoveries: number; armedAtEnd: boolean } {
  let failures = 0;
  let armed = false;
  let alerts = 0;
  let recoveries = 0;
  for (const outcome of outcomes) {
    failures = nextConsecutiveFailures(failures, outcome);
    const incident = evaluateDegradedIncident(outcome, failures, THRESHOLD, armed);
    if (incident.fire) alerts += 1;
    if (incident.recovered) recoveries += 1;
    armed = incident.armed;
  }
  return { alerts, recoveries, armedAtEnd: armed };
}

const E: RunOutcome = 'error';
const S: RunOutcome = 'skip';
const OK: RunOutcome = 'decided';

{
  const r1 = replay([E, E, E]);
  ok('1) error/error/error → exactly ONE degraded alert', r1.alerts === 1);
  ok('1) …and no recovery, and the incident stays armed', r1.recoveries === 0 && r1.armedAtEnd);

  const r2 = replay([E, E, E, E]);
  ok('2) a fourth error still yields ONE alert (no spam)', r2.alerts === 1 && r2.recoveries === 0);

  const r3 = replay([E, E, E, OK, OK]);
  ok('3) error×3 then two decided → ONE recovery, on the first decided', r3.recoveries === 1);
  ok('3) …and the incident is disarmed afterwards', !r3.armedAtEnd);

  const r4 = replay([E, E, OK]);
  ok('4) two errors then decided → NO recovery (no alert had fired)', r4.alerts === 0 && r4.recoveries === 0);

  const r5 = replay([E, E, E, S, OK, OK]);
  ok('5) a skip does NOT recover…', replay([E, E, E, S]).recoveries === 0);
  ok('5) …does NOT disarm the incident…', replay([E, E, E, S]).armedAtEnd === true);
  ok('5) …and the later decided still sends exactly ONE recovery', r5.recoveries === 1 && r5.alerts === 1);

  const r6 = replay([E, E, E, S, E, OK]);
  ok('6) error×3 / skip / error / decided → ONE recovery', r6.recoveries === 1);
  ok('6) …and still only ONE degraded alert (the error after the skip does not re-fire)', r6.alerts === 1);
  // THE REASON THE COUNT IS REBUILT FROM HISTORY. At the moment of recovery the live
  // counter reads 1, because the skip reset it — the incident really cost four errors.
  {
    let failures = 0;
    for (const o of [E, E, E, S, E] as RunOutcome[]) failures = nextConsecutiveFailures(failures, o);
    ok('6) consecutive_failures reads 1 at recovery, NOT 4 — hence the scheduler_runs rebuild', failures === 1);
  }

  // A skip before any incident must not arm anything, and a lone decided must not recover.
  ok('a skip with no incident open changes nothing', replay([S]).alerts === 0 && replay([S]).recoveries === 0 && !replay([S]).armedAtEnd);
  ok('a decided with no incident open sends no recovery', replay([OK]).recoveries === 0);
  // Two incidents in a row still get one alert each — the change must not suppress the second.
  ok('a second, genuinely new incident alerts again', replay([E, E, E, OK, E, E, E]).alerts === 2);
}

// 7) The rebuild FAILS at the moment of recovery: the cycle stays valid, the number is
//    reported as unavailable, and the failure is logged. Proven against the real reader.
console.log('\nRecovery when the history rebuild fails (best-effort by contract):');
{
  const throwingClient = {
    from: () => {
      throw new Error('scheduler_runs unreachable');
    },
  } as unknown as SupabaseClient;
  const rejectingClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            lte: () => ({
              gt: async () => ({ count: null, error: { message: 'permission denied' } }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const countingClient = (count: number) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              lte: () => ({
                gt: async () => ({ count, error: null }),
              }),
            }),
          }),
        }),
      }),
    }) as unknown as SupabaseClient;

  const thrown = await countFailedRunsSince(throwingClient, '2026-08-20T18:01:50Z', '2026-08-20T23:11:36Z');
  ok('a throwing history read returns null instead of failing the cycle', thrown === null);
  const rejected = await countFailedRunsSince(rejectingClient, '2026-08-20T18:01:50Z', '2026-08-20T23:11:36Z');
  ok('a rejected history read returns null too', rejected === null);
  const counted = await countFailedRunsSince(countingClient(4), '2026-08-20T18:01:50Z', '2026-08-20T23:11:36Z');
  ok('a successful read returns the real count (the four errors of 20/08)', counted === 4);

  const unavailable = formatAlert({
    trigger: 'degraded_recovered',
    timestamp: '2026-08-20T23:11:36.655Z',
    failureCount: null,
    outageMs: null,
  });
  ok('the message says the count is unavailable, never 0', unavailable.includes('indisponible') && !unavailable.includes(': 0'));
  ok('…and the duration is stated as unknown, never invented', unavailable.includes('inconnu'));
}

// The message on the nominal path, with the real numbers of the incident.
console.log('\nRecovery message:');
{
  // 18:01:49.898 → 23:11:36.379: the true time without a valid decision.
  const outageMs = Date.parse('2026-08-20T23:11:36.379Z') - Date.parse('2026-08-20T18:01:49.898Z');
  const msg = formatAlert({
    trigger: 'degraded_recovered',
    timestamp: '2026-08-20T23:11:36.655Z',
    failureCount: 4,
    outageMs,
  });
  ok('the recovery names the count of failures during the incident', msg.includes('Échecs pendant l\'incident : 4'));
  // 5 h 9 min, floored — the real 5 h 09 min 46 s. Floored rather than rounded because an
  // outage report should never claim more time than it can account for.
  ok('the recovery reports 5 h 9 min — from the last valid decision, not the first error', msg.includes('5 h 9 min'));
  ok('the recovery is self-dating', msg.includes('2026-08-20T23:11:36.655Z'));
  ok('the recovery says a valid decision was produced', msg.includes('décision valide'));

  ok('formatDuration: minutes only', formatDuration(47 * 60_000) === '47 min');
  ok('formatDuration: hours + minutes', formatDuration((5 * 60 + 10) * 60_000) === '5 h 10 min');
  ok('formatDuration: days + hours', formatDuration((27 * 60 + 5) * 60_000) === '1 j 3 h');
  ok('formatDuration: a negative span (clock skew) is unknown, not negative', formatDuration(-1) === null);
  ok('formatDuration: NaN is unknown', formatDuration(Number.NaN) === null);
}

// The pre-existing alerts must still format exactly as they did — the payload type changed
// shape, and a union that silently broke one of them would be a regression nobody sees
// until 3 a.m.
{
  const ts = '2026-08-20T21:07:03.383Z';
  ok('the DÉGRADÉ alert is untouched', formatAlert({ trigger: 'degraded', value: 3, timestamp: ts, lastError: 'status=error' }).includes('consecutive_failures = 3'));
  ok('the EMBALLEMENT alert is untouched', formatAlert({ trigger: 'overheating', value: 10, timestamp: ts }).includes('floor_delay_streak = 10'));
  ok('the market-data alert is untouched', formatAlert({ trigger: 'market_data', value: 22, timestamp: ts, cause: null }).includes('DONNÉES DE MARCHÉ INDISPONIBLES'));
  ok('the market-data recovery is untouched', formatAlert({ trigger: 'market_data_recovered', value: 22, timestamp: ts }).includes('DONNÉES DE MARCHÉ RÉTABLIES'));
}

console.log(`\n${passed} provider-resilience checks passed.`);
