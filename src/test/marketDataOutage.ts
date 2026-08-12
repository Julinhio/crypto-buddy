import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { binance } from 'ccxt';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  captureHttpErrors,
  errorClassOf,
  parseCcxtMessage,
  type HttpErrorTrace,
} from '../exchanges/errorCapture.js';
import { PROBE_URL, probeAlternateEndpoint } from '../market/probe.js';
import { recordMarketDataOutage, summarise } from '../market/outage.js';
import { saveMarketDataIncident, type MarketFailure } from '../persistence/marketDataIncidents.js';
import { evaluateAlert, evaluateRecovery, nextBlindCycles } from '../scheduler/policy.js';
import { formatAlert } from '../alerting/messages.js';
import { config, validateOutageBudget } from '../config/index.js';
import { blindBlocks, incidentCycles } from '../replay/marketDataOutageWindow.js';

/**
 * Offline proof of the market-data outage visibility (no network, no DB, no LLM).
 *
 * The two constraints the brief says must be DEMONSTRATED rather than asserted get the
 * most attention here:
 *
 *   §3 — the probe can never reach a decision. Proven three ways: by the import graph
 *        (only one module may import it), by the signature (`void`), and by showing that
 *        two opposite probe results change nothing outside the probe_* columns.
 *   §4 — the probe is bounded. A probe that NEVER answers must not extend the work past
 *        its bound; same for the write.
 */

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok: ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const SRC = resolve(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§3a — THE PROBE CANNOT REACH A DECISION: the import graph');
// The strongest form of the proof, and the one that keeps holding as the code changes.
// If the probe is importable from only ONE module, and that module hands its result to
// nothing, then no decision path can read it — today or after any future edit.
{
  const files = walk(SRC).filter((f) => !f.includes(`${'test'}`) && !f.includes('replay'));
  const importers = files
    .filter((f) => /from\s+'[^']*\/probe\.js'/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'));

  ok(
    'market/probe.js is imported by exactly one production module',
    importers.length === 1,
    `importers: ${JSON.stringify(importers)}`,
  );
  ok(
    'and that module is market/outage.ts — the void-returning one',
    importers[0] === 'market/outage.ts',
    `got ${importers[0]}`,
  );

  // The other half: outage.ts's own consumers must not be able to read anything from it.
  const outageImporters = files
    .filter((f) => /from\s+'[^']*\/outage\.js'/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).replace(/\\/g, '/'));
  ok(
    'market/outage.js is imported by exactly one production module (decision/decide.ts)',
    outageImporters.length === 1 && outageImporters[0] === 'decision/decide.ts',
    `importers: ${JSON.stringify(outageImporters)}`,
  );

  // And its single call site must DISCARD the call — no assignment, no destructuring.
  // `void` already guarantees the value is useless; this catches the reviewer-visible
  // form too, so a future edit that tried to use it would look wrong as well as fail.
  const decideSrc = readFileSync(join(SRC, 'decision', 'decide.ts'), 'utf8');
  const callSites = decideSrc.match(/^.*recordMarketDataOutage\s*\(/gm) ?? [];
  ok('recordMarketDataOutage is called exactly once in decide.ts', callSites.length === 1);
  ok(
    'and its result is discarded (bare `await`, never assigned)',
    /await recordMarketDataOutage\(/.test(decideSrc) &&
      !/=\s*await\s+recordMarketDataOutage/.test(decideSrc),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§3b — THE PROBE CANNOT REACH A DECISION: opposite probes, identical row');
// Runtime complement to the static proof: run the whole failure path twice with probe
// results that disagree on every field, and assert that NOTHING outside the probe_*
// columns differs. The row is the only thing the probe touches, and only in its own
// four columns.
{
  const captured: Record<string, unknown>[] = [];
  const recordingSupabase = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        captured.push(row);
        return { abortSignal: () => Promise.resolve({ error: null }) };
      },
    }),
  } as unknown as SupabaseClient;

  const failures: MarketFailure[] = [
    {
      symbol: 'BTC/USDT',
      kind: 'tradable',
      stage: 'pair',
      dropped: true,
      errorClass: 'ExchangeNotAvailable',
      httpStatus: 451,
      endpoint: 'https://api.binance.com/api/v3/klines',
      message: 'binance GET https://api.binance.com/api/v3/klines 451 blocked',
    },
  ];
  const input = {
    supabase: recordingSupabase,
    decisionId: null,
    runToken: null,
    blind: true,
    marketsAttempted: 5,
    marketsFailed: 1,
    failures,
    httpTraces: [] as HttpErrorTrace[],
    tracesDropped: 0,
  };

  const returnedA = await recordMarketDataOutage(input, {
    probe: async () => ({ reachable: true, httpStatus: 200, latencyMs: 42, error: null }),
  });
  const returnedB = await recordMarketDataOutage(input, {
    probe: async () => ({ reachable: false, httpStatus: 451, latencyMs: 4999, error: 'blocked too' }),
  });

  ok('recordMarketDataOutage returns undefined (void) whatever the probe said',
    returnedA === undefined && returnedB === undefined);
  ok('both runs wrote exactly one row each', captured.length === 2);

  const [a, b] = captured as [Record<string, unknown>, Record<string, unknown>];
  const PROBE_COLUMNS = new Set([
    'probe_attempted',
    'probe_reachable',
    'probe_http_status',
    'probe_latency_ms',
    'probe_error',
  ]);
  const nonProbeDiffs = Object.keys(a).filter(
    (k) => !PROBE_COLUMNS.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
  ok(
    'two opposite probe results change NOTHING outside the probe_* columns',
    nonProbeDiffs.length === 0,
    `differing: ${JSON.stringify(nonProbeDiffs)}`,
  );
  ok(
    'the probe result DID land in its own columns (the test is not vacuous)',
    a.probe_reachable === true && b.probe_reachable === false && a.probe_http_status === 200,
  );
  ok('the probe URL is the market-metadata call, not a bare /ping',
    PROBE_URL.includes('/api/v3/exchangeInfo') && PROBE_URL.includes('symbol=BTCUSDT'));
  ok('the probe targets the ALTERNATE host, not the production one',
    PROBE_URL.includes('data-api.binance.vision') && !PROBE_URL.includes('api.binance.com'));
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§4 — THE PROBE AND THE WRITE ARE BOUNDED');
// The regression the brief asks for by name: a probe that NEVER answers must not extend
// the cycle past its bound. Same for a write that never settles. Both run on the failure
// path, so an unbounded one would reproduce the PR #26 defect — an observational call
// able to reach the watchdog.
{
  const BOUND_MS = 200;
  // Generous slack: we are asserting "bounded", not "fast". A bound that held at exactly
  // 200ms on a loaded CI box would be a flaky test, not a stronger one.
  const SLACK_MS = 1_500;

  {
    const started = Date.now();
    await recordMarketDataOutage(
      {
        supabase: null,
        decisionId: null,
        runToken: null,
        blind: true,
        marketsAttempted: 5,
        marketsFailed: 5,
        failures: [],
        httpTraces: [],
        tracesDropped: 0,
      },
      {
        // Never resolves, and ignores the abort signal entirely — the worst case, and the
        // reason the probe is raced by its CALLER as well as by its own AbortSignal.
        probe: () => new Promise(() => {}),
        probeTimeoutMs: BOUND_MS,
        writeDeadlineMs: BOUND_MS,
      },
    );
    const elapsed = Date.now() - started;
    ok(
      `a probe that NEVER answers still returns within its bound (${elapsed}ms ≤ ${BOUND_MS + SLACK_MS}ms)`,
      elapsed <= BOUND_MS + SLACK_MS,
      `took ${elapsed}ms`,
    );
  }

  {
    // A query Supabase accepts and never settles. `Promise.resolve(thenable)` calls
    // `.then`, which here never invokes either callback — so only the independent timer
    // inside runBoundedWrite can end the race.
    const hangingQuery = { then: () => {}, abortSignal(): unknown { return this; } };
    const hangingSupabase = {
      from: () => ({ insert: () => hangingQuery }),
    } as unknown as SupabaseClient;

    const started = Date.now();
    const landed = await saveMarketDataIncident(
      hangingSupabase,
      {
        decision_id: null, run_token: null, blind: true,
        markets_attempted: 5, markets_failed: 5,
        error_class: null, http_status: null, endpoint: null, retry_after: null,
        failures: [], http_traces: [],
        probe_attempted: false, probe_reachable: null, probe_http_status: null,
        probe_latency_ms: null, probe_error: null,
      },
      BOUND_MS,
    );
    const elapsed = Date.now() - started;
    ok(
      `a write that NEVER settles returns within its bound (${elapsed}ms ≤ ${BOUND_MS + SLACK_MS}ms)`,
      elapsed <= BOUND_MS + SLACK_MS,
      `took ${elapsed}ms`,
    );
    ok('and it reports the miss rather than claiming success', landed === false);
  }

  {
    // The probe itself never throws — a rejected fetch is a RESULT, not an exception.
    const res = await probeAlternateEndpoint(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }, 50);
    ok('probeAlternateEndpoint never throws; a transport failure becomes a result',
      res.reachable === false && res.httpStatus === null && res.error !== null);
  }

  // The budget relation is asserted at startup, not assumed. A probe+write that did not
  // fit alongside two LLM attempts and the reserve must fail the boot.
  ok('the real config satisfies the outage budget invariant',
    (() => { try { validateOutageBudget(config.decision, config.scheduler); return true; } catch { return false; } })());
  ok('an oversized outage budget FAILS the boot rather than silently fitting',
    (() => {
      try {
        validateOutageBudget(config.decision, config.scheduler, 60_000, 60_000);
        return false;
      } catch { return true; }
    })());
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§1 — THE ERROR IS CAPTURED, STRUCTURED');
{
  // The `handleErrors` hook: the ONLY place `Retry-After` is reachable. It is also a
  // wrapper on the production data path, so the delegation must be provably intact.
  const calls: unknown[][] = [];
  const fake = {
    handleErrors(...args: unknown[]): unknown {
      calls.push(args);
      return 'delegated';
    },
  };
  const read = captureHttpErrors(fake as unknown as binance);

  const returned = (fake as { handleErrors: (...a: unknown[]) => unknown }).handleErrors(
    451,
    'Unavailable For Legal Reasons',
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=500',
    'GET',
    { 'Retry-After': '120', 'Content-Type': 'text/html' },
    '<html>Service unavailable from a restricted location.</html>',
  );

  ok('the wrapper ALWAYS delegates and returns the original value verbatim',
    returned === 'delegated' && calls.length === 1);
  ok('the wrapper passes every argument through untouched',
    (calls[0] as unknown[]).length === 6 && (calls[0] as unknown[])[0] === 451);

  const captured = read();
  const t = captured.traces[0];
  ok('the HTTP status is captured', t?.httpStatus === 451);
  ok('the Retry-After header is captured — unreachable from the thrown error',
    t?.retryAfter === '120');
  ok('the endpoint is captured WITHOUT its query string (groupable)',
    t?.endpoint === 'https://api.binance.com/api/v3/klines');
  ok('the body excerpt is kept (a 451 page names its blocker)',
    (t?.bodyExcerpt ?? '').includes('restricted location'));

  // A healthy response must record nothing at all.
  (fake as { handleErrors: (...a: unknown[]) => unknown }).handleErrors(
    200, 'OK', 'https://api.binance.com/api/v3/klines', 'GET', {}, '[]',
  );
  ok('a 200 records nothing — a healthy cycle stores no traces', read().traces.length === 1);

  const read2 = captureHttpErrors({ handleErrors: () => undefined } as unknown as binance);
  ok('errorClassOf names the ccxt class, which separates a block from a timeout',
    errorClassOf(Object.assign(new Error('x'), { name: 'ExchangeNotAvailable' })) === 'ExchangeNotAvailable');
  ok('errorClassOf falls back sanely on a plain Error',
    errorClassOf(new Error('boom')) === 'Error');
  ok('read2 starts empty', read2().traces.length === 0);

  // The message-parsing fallback, for transport failures where no response ever existed.
  const parsed = parseCcxtMessage(
    'binance GET https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT 418 I am a teapot',
  );
  ok('the ccxt message fallback recovers the status', parsed.httpStatus === 418);
  ok('the ccxt message fallback recovers the endpoint',
    parsed.endpoint === 'https://api.binance.com/api/v3/ticker/price');
  ok('and it degrades to nulls rather than guessing',
    parseCcxtMessage('some unrelated error').httpStatus === null);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§1b — the summary prefers the authoritative HTTP trace over the parsed message');
{
  const failures: MarketFailure[] = [
    { symbol: 'BTC/USDT', kind: 'tradable', stage: 'pair', dropped: true, errorClass: 'ExchangeNotAvailable', httpStatus: null, endpoint: null, message: 'm' },
    { symbol: 'ETH/USDT', kind: 'tradable', stage: 'pair', dropped: true, errorClass: 'ExchangeNotAvailable', httpStatus: null, endpoint: null, message: 'm' },
    { symbol: 'SOL/USDT', kind: 'reference', stage: 'tactical', dropped: false, errorClass: 'RequestTimeout', httpStatus: null, endpoint: null, message: 'm' },
  ];
  const traces: HttpErrorTrace[] = [
    { httpStatus: 451, method: 'GET', endpoint: 'https://api.binance.com/api/v3/klines', retryAfter: null, bodyExcerpt: null },
    { httpStatus: 429, method: 'GET', endpoint: 'https://api.binance.com/api/v3/ticker/price', retryAfter: '30', bodyExcerpt: null },
  ];
  const s = summarise(failures, traces);
  ok('the dominant ccxt class wins the summary', s.errorClass === 'ExchangeNotAvailable');
  ok('the HTTP status comes from the trace', s.httpStatus === 451);
  ok('Retry-After is found even when it is not on the first trace', s.retryAfter === '30');
  ok('summarise is total — an empty input yields nulls, not a throw',
    summarise([], []).errorClass === null);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§2 — THE TWO HEALTH STATES ARE SEPARATE');
{
  ok('a blind cycle increments the blind counter', nextBlindCycles(2, 'blind') === 3);
  ok('a cycle that SEES the market resets it', nextBlindCycles(22, 'sighted') === 0);
  // The load-bearing one. A frozen cycle is not evidence of an outage, and it is not
  // evidence of a recovery either — it has its own alarms (watchdog, kept lock, missing
  // Healthchecks ping). Collapsing it either way would make the alert fire on freezes or
  // go quiet in the middle of a real outage.
  ok('an UNKNOWN cycle leaves the counter exactly where it was',
    nextBlindCycles(2, 'unknown') === 2 && nextBlindCycles(0, 'unknown') === 0);

  // And the separation itself: the blind counter is NOT the failure counter. A blind
  // cycle is classified `skip`, which resets consecutive_failures — that is precisely why
  // 31 blind cycles left the degraded alert unarmed, and this PR does not change it.
  const { classifyOutcome, nextConsecutiveFailures } = await import('../scheduler/policy.js');
  ok('a blind cycle is still classified `skip` (behaviour unchanged)',
    classifyOutcome('skipped') === 'skip');
  ok('and `skip` still resets consecutive_failures (behaviour unchanged)',
    nextConsecutiveFailures(2, 'skip') === 0);
  ok('so the two health states cannot mask each other',
    nextConsecutiveFailures(2, 'skip') === 0 && nextBlindCycles(2, 'blind') === 3);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§3 — THE ALERT DEBOUNCES LIKE THE EXISTING ONES');
{
  const TH = config.alerting.blindCyclesThreshold;
  ok(`the threshold is the calibrated 3 (got ${TH})`, TH === 3);

  ok('silent below the threshold', evaluateAlert(2, TH, false).fire === false);
  ok('fires once ON the crossing', evaluateAlert(3, TH, false).fire === true);
  ok('silent while it stays above — 22 blind cycles produce ONE message',
    evaluateAlert(22, TH, true).fire === false);
  ok('re-arms when the market comes back', evaluateAlert(0, TH, true).sent === false);
  ok('and fires again on a genuine re-cross', evaluateAlert(3, TH, false).fire === true);

  ok('recovery fires only on the DOWNWARD crossing of an armed alert',
    evaluateRecovery(0, TH, true) === true);
  ok('no recovery when it was never armed — the isolated failure stays silent',
    evaluateRecovery(0, TH, false) === false);
  ok('no recovery while still blind', evaluateRecovery(5, TH, true) === false);

  // The two existing triggers must NOT have gained a recovery message.
  const msg = formatAlert({ trigger: 'market_data', value: 3, timestamp: 'T', cause: 'ExchangeNotAvailable / 451' });
  ok('the alert names the real condition and reassures about the bot',
    msg.includes('DONNÉES DE MARCHÉ INDISPONIBLES') && msg.includes('fail-closed'));
  ok('the alert carries the structured cause when there is one',
    msg.includes('451'));
  const rec = formatAlert({ trigger: 'market_data_recovered', value: 22, timestamp: 'T' });
  ok('the recovery message reports the outage length', rec.includes('22 cycles'));
  // The recovery fires on `marketData === 'sighted'`, which says NOTHING about the cycle's
  // outcome: that same cycle can still end error/parse_failed/guard_failed, or skip on a
  // different dependency. The message must not hand out an all-clear it cannot support.
  ok('the recovery message claims ONLY that the data is back, not that decisions resumed',
    !/repris ses décisions/.test(rec) && rec.includes('données exploitables'));
  ok('and it points at the trigger that DOES cover a failing cycle',
    rec.includes('dégradé'));
  ok('the degraded alert wording is untouched',
    formatAlert({ trigger: 'degraded', value: 3, timestamp: 'T' }).includes('DÉGRADÉ'));
  ok('the overheating alert wording is untouched',
    formatAlert({ trigger: 'overheating', value: 10, timestamp: 'T' }).includes('EMBALLEMENT'));
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§0 — the frozen window still describes the incident the brief states');
{
  // The brief's figures are stated over the INCIDENT (03:55 → 03:30); the frozen table
  // brackets it wider on purpose, so narrow before comparing.
  const incident = incidentCycles();
  const blind = incident.filter((c) => c.blind);
  ok('31 blind cycles', blind.length === 31, `got ${blind.length}`);
  ok('blocks of 1, 4, 22, 4', JSON.stringify(blindBlocks()) === JSON.stringify([1, 4, 22, 4]),
    JSON.stringify(blindBlocks()));
  const avg = blind.reduce((s, c) => s + c.durationSeconds, 0) / blind.length;
  ok(`failing cycles average ~1.24s (got ${avg.toFixed(2)}s)`, Math.abs(avg - 1.24) < 0.05);
  const sighted = incident.filter((c) => !c.blind);
  const avgOk = sighted.reduce((s, c) => s + c.durationSeconds, 0) / sighted.length;
  ok(`healthy cycles average ~28.70s (got ${avgOk.toFixed(2)}s)`, Math.abs(avgOk - 28.7) < 0.05);
  ok('a failing cycle is ~23× faster than a healthy one — immediate, not a timeout',
    avgOk / avg > 20);
}

console.log(
  `\n${passed} passed, ${failed} failed — market-data outage visibility (offline).`,
);
assert.equal(failed, 0, `${failed} check(s) failed`);
