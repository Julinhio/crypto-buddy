/**
 * THE DIAGNOSTIC PROBE — one request, at the moment of the failure, from the same
 * instance. It exists to answer exactly one question and then shut up.
 *
 * The 09/08 hypothesis is that Railway's exit IP was refused by `api.binance.com`. Nobody
 * can prove it, because nothing was kept. The probe makes the NEXT occurrence decidable:
 * if `data-api.binance.vision` answers from this same exit IP at the exact moment
 * `api.binance.com` refuses, the problem is the host or its geo/IP policy, not the
 * network, not Railway, not the bot.
 *
 * The request is not arbitrary. `exchangeInfo?symbol=BTCUSDT` is the equivalent of the
 * common call that failed — the one that loads market metadata. A bare `/ping` would
 * answer and prove nothing: it is served by different infrastructure rules and would come
 * back 200 in exactly the scenario we are trying to distinguish.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────
 *
 * NOT a failover, NOT a second data source, NOT a fallback price. The result is written
 * to `market_data_incidents` and read by nobody. `api.binance.com` remains the production
 * source: the 451 is an unconfirmed hypothesis, and the bot's most critical data path
 * does not get rerouted on a guess.
 *
 * The guarantee is structural rather than promised — see `recordMarketDataOutage` in
 * ./outage.ts, whose return type is `void`. This module has exactly one caller and that
 * caller cannot leak the result anywhere.
 */

import { PROBE_TIMEOUT_MS } from '../config/index.js';

/**
 * The alternate PUBLIC data endpoint, and the same call shape that failed. Exported so the
 * test asserts the URL rather than trusting a comment: a probe that quietly drifted to
 * `/ping` would keep passing while testing nothing.
 */
export const PROBE_URL = 'https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT';

/**
 * HARD bound on the probe. Declared in `config/index.ts` next to the cycle budget it is
 * asserted against (`validateOutageBudget`), and re-exported here so callers of the probe
 * read it from the probe. One source, so the timer and the invariant cannot drift.
 */
export { PROBE_TIMEOUT_MS };

export interface ProbeResult {
  /** Did the endpoint answer with a 2xx from this exit IP? */
  reachable: boolean;
  /** The status it answered with, null when nothing came back (timeout, DNS, refused). */
  httpStatus: number | null;
  /** Wall-clock of the probe. A 4.9s value next to a 5s bound means it was cut off. */
  latencyMs: number;
  /** Why it produced no status. Null on any answered request, including a 451. */
  error: string | null;
}

/**
 * Probes the alternate endpoint ONCE. NEVER throws, NEVER exceeds PROBE_TIMEOUT_MS.
 *
 * `fetchImpl` and `timeoutMs` are seams for the offline tests (including the one that
 * proves a probe which never answers still returns within its bound); production passes
 * neither.
 */
export async function probeAlternateEndpoint(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const started = Date.now();
  // The abort signal bounds a request that CONNECTS and then stalls. It does not bound a
  // `fetchImpl` that ignores signals entirely, so the caller (outage.ts) races this whole
  // call against its own deadline as well — two independent bounds, because a single one
  // that can be defeated by its own dependency is not a bound.
  try {
    const res = await fetchImpl(PROBE_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      reachable: res.ok,
      httpStatus: res.status,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}
