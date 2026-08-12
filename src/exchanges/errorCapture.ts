import type { binance } from 'ccxt';

/**
 * CAPTURING WHAT CCXT THROWS AWAY.
 *
 * The 09/08 outage left exactly one durable fact behind: the string `status=skipped`.
 * No HTTP code, no endpoint, no error class — which is why "the exit IP got blocked" is
 * still a hypothesis nobody can prove. The detail existed; it lived in `console.warn` and
 * died with the process.
 *
 * Two of the five fields the post-mortem needs are unreachable from the thrown error:
 *
 *   - ccxt's exception objects carry only `name`, `message` and `stack` (verified against
 *     ccxt 4.5.56). The HTTP status and URL are *formatted into the message* by
 *     `handleHttpStatusCode` — recoverable by parsing, which we also do as a fallback;
 *   - the `Retry-After` header is not in the message at all. It is handed to
 *     `Exchange.handleErrors(code, reason, url, method, headers, …)` and then dropped on
 *     the floor. Intercepting that call is the ONLY way to keep it.
 *
 * So we wrap `handleErrors` on our own client instance. Three properties make this safe to
 * put in the production data path:
 *
 *   1. it ALWAYS delegates to the original and returns its value verbatim — the wrapper
 *      cannot change what ccxt decides to throw;
 *   2. the recording is wrapped in its own try/catch — a bug in this file cannot turn a
 *      normal HTTP error into a different one, nor break a healthy response;
 *   3. it only records when the status is an error (>= 400), so a healthy cycle costs one
 *      integer comparison per response and stores nothing.
 *
 * Per-CLIENT, not global: `publicMainnetClient()` builds a fresh instance per cycle, so
 * the buffer's lifetime is the cycle's and there is nothing to reset between runs. The
 * cap below is the only thing standing between a pathological cycle and unbounded memory.
 */

/** One HTTP response that ccxt was about to turn into an exception. */
export interface HttpErrorTrace {
  /** The HTTP status as returned (451, 429, 418, 5xx…). */
  httpStatus: number;
  /** GET/POST — kept because a failing GET and a failing POST are different stories. */
  method: string;
  /**
   * The endpoint, WITHOUT its query string. `…/api/v3/klines?symbol=BTCUSDT&limit=500`
   * becomes `…/api/v3/klines`: the path is what identifies the blocked route, and keeping
   * the query would make every row unique and un-groupable. The symbol is already carried
   * per-market by the failure list.
   */
  endpoint: string;
  /** `Retry-After` verbatim — the spec allows seconds OR an HTTP date, so no conversion. */
  retryAfter: string | null;
  /** Response body, truncated. On a 451 this is the block page, which names the blocker. */
  bodyExcerpt: string | null;
}

/** Enough of a 451 block page or a JSON error to identify it; not enough to bloat a row. */
const MAX_BODY_CHARS = 400;
/**
 * Hard cap on traces per client. A cycle makes ~15 public calls, so 50 is generous; the
 * cap exists so a pathological retry storm cannot grow this buffer without bound inside
 * a long cycle. Overflow is DROPPED (the first 50 identify the outage just as well) and
 * counted, so the row never claims a completeness it doesn't have.
 */
const MAX_TRACES = 50;

/** Case-insensitive header lookup — ccxt capitalizes keys, but we don't depend on it. */
function header(headers: Record<string, string> | undefined, name: string): string | null {
  if (headers == null || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return typeof value === 'string' ? value : String(value);
  }
  return null;
}

/** Strips the query string; falls back to the raw URL when it isn't parseable. */
function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export interface CapturedErrors {
  /** The traces recorded so far, oldest first (a copy — callers cannot mutate the buffer). */
  traces: HttpErrorTrace[];
  /** How many traces were dropped once the cap was reached. 0 in every realistic cycle. */
  dropped: number;
}

/**
 * Wraps `handleErrors` on `client` so failing HTTP responses are recorded, and returns the
 * reader. Behaviour-preserving by construction — see the header.
 *
 * Returns a reader that always works: if the wrap itself fails (a future ccxt refactor
 * renames the hook), we log once and hand back an empty reader rather than throwing. The
 * cycle must never die because its observability could not be installed.
 */
export function captureHttpErrors(client: binance): () => CapturedErrors {
  const traces: HttpErrorTrace[] = [];
  const counters = { dropped: 0 };
  const read = (): CapturedErrors => ({ traces: [...traces], dropped: counters.dropped });

  try {
    // `handleErrors` lives on the prototype; assigning here shadows it with an own
    // property on this instance only. Other instances (the testnet account client) are
    // untouched.
    const target = client as unknown as {
      handleErrors: (...args: unknown[]) => unknown;
    };
    const original = target.handleErrors.bind(client);

    target.handleErrors = (...args: unknown[]): unknown => {
      try {
        const [code, , url, method, headers, body] = args as [
          number,
          string,
          string,
          string,
          Record<string, string> | undefined,
          string | undefined,
        ];
        if (typeof code === 'number' && code >= 400) {
          if (traces.length >= MAX_TRACES) {
            counters.dropped++;
          } else {
            traces.push({
              httpStatus: code,
              method: typeof method === 'string' ? method : 'GET',
              endpoint: typeof url === 'string' ? endpointOf(url) : 'unknown',
              retryAfter: header(headers, 'Retry-After'),
              bodyExcerpt:
                typeof body === 'string' && body.length > 0
                  ? body.slice(0, MAX_BODY_CHARS)
                  : null,
            });
          }
        }
      } catch {
        // Observability must never alter the data path. A throw here would surface as a
        // DIFFERENT error than the one Binance actually returned — the exact confusion
        // this module exists to remove.
      }
      // ALWAYS delegate, ALWAYS return verbatim. This is the line that makes the wrapper
      // invisible to ccxt's own error handling.
      return original(...args);
    };
  } catch (err) {
    console.warn(
      `[warn] could not install the HTTP error capture (${err instanceof Error ? err.message : String(err)}) — ` +
        'market reads are unaffected; an outage would just be journaled without its HTTP detail.',
    );
  }

  return read;
}

/**
 * The ccxt error class name (`ExchangeNotAvailable`, `DDoSProtection`, `RequestTimeout`…).
 *
 * This one field separates the hypotheses on its own: a `RequestTimeout` is a slow or
 * unreachable network, an `ExchangeNotAvailable` carrying a 451 is a refusal to serve this
 * IP. On 09/08 we had neither, only "skipped".
 */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error) {
    // ccxt sets `name` on its exception classes; the constructor name is the fallback for
    // a plain Error (and for anything the bundler has renamed).
    return err.name && err.name !== 'Error' ? err.name : err.constructor.name;
  }
  return typeof err;
}

/**
 * Last-resort status/endpoint recovery from ccxt's message, which
 * `handleHttpStatusCode` formats as `<id> <METHOD> <url> <code> <reason> <body>`.
 *
 * Only used when the `handleErrors` hook captured nothing — which happens for a
 * TRANSPORT-level failure (DNS, refused connection, timeout): there is no response at all,
 * so there is nothing to intercept and nothing to parse either. Keeping this fallback
 * costs a regex and means a future ccxt refactor of the hook degrades the trace instead of
 * emptying it.
 */
export function parseCcxtMessage(message: string): { httpStatus: number | null; endpoint: string | null } {
  const match = /\b(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+(\d{3})\b/.exec(message);
  if (!match) return { httpStatus: null, endpoint: null };
  const [, , url, status] = match;
  return {
    httpStatus: url != null && status != null ? Number(status) : null,
    endpoint: url != null ? endpointOf(url) : null,
  };
}
