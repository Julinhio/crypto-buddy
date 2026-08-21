import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';

/**
 * CLASSIFYING WHAT THE LLM PATH THROWS — the one place in the codebase that decides
 * whether a failed decision cycle is worth coming back to soon.
 *
 * THE INCIDENT THAT MADE THIS NECESSARY (20/08/2026). Four consecutive cycles died on
 * the same wall: model `claude-sonnet-4-6`, `Request was aborted.`, ~90 008 ms, no
 * allocation, no order. Anthropic declared an incident from ~19:16 to ~19:42 UTC — which
 * covers exactly ONE of the four. The other three failed because the provider stayed slow
 * afterwards, and because the generic backoff kept doubling on a fault that had nothing to
 * do with the bot: 15 / 30 / 60 / 120 minutes. Last good decision 18:01:50, next one
 * 23:11:36 — 5 h 10 min blind, of which roughly four hours were self-inflicted waiting.
 *
 * The 90 s deadline is NOT the defect and is not touched here. The defect is that a
 * TRANSPORT fault on the provider's side is indistinguishable, to the scheduler, from a
 * broken prompt or a broken schema — so it gets the same escalating punishment. This
 * module draws that distinction, ONCE, and hands it downstream as a typed value.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 *   1. NOTHING IS CLASSIFIED FROM A MESSAGE. `Request was aborted.` is a human-facing
 *      string owned by the SDK; the day it is reworded, a message-matching classifier
 *      silently stops recognising the very fault it was written for — and it would fail
 *      OPEN, sending a real deadline into the generic four-hour backoff, i.e. exactly the
 *      incident again. Classification reads TYPES and HTTP STATUS only. The local deadline
 *      is recognised through `LlmAttemptDeadlineError`, which is constructed by the code
 *      that OWNS the AbortSignal and therefore knows, with certainty, that its own timer
 *      fired. `src/test/llmResilience.ts` pins this: reword the deadline error and its
 *      class must not move.
 *
 *   2. AN UNKNOWN ERROR IS NEVER RETRYABLE. The retryable class shortens the backoff; a
 *      mistake in that direction makes a permanently broken bot hammer the API every 30
 *      minutes while looking healthy. Only the four listed causes qualify. Everything else
 *      — auth, a missing key, config, parsing, the coherence guard, Supabase, application
 *      logic, and anything unrecognised — keeps the existing generic policy.
 */

/**
 * The only failure class this PR introduces. Deliberately typed as a string union rather
 * than a boolean: the scheduler switches on it, and a boolean would have to be renamed the
 * day a second class (say, a provider-side content refusal) needs its own policy.
 */
export type LlmFailureClass = 'retryable_llm_transport';

/**
 * THE LOCAL ATTEMPT DEADLINE, as a TYPE rather than as a sentence.
 *
 * Thrown by `runDecision` — the component that creates and owns the `AbortSignal` — and
 * only when its own timer is the thing that fired. That ownership is the whole point: an
 * `APIUserAbortError` reaching the classifier WITHOUT this wrapper means something else
 * aborted the request, and "something else" is not a known-transient provider fault. It
 * falls through to unclassified, and keeps the generic backoff.
 *
 * `cause` carries whatever the SDK threw, for the human reading the journal. It is never
 * read to establish the class.
 */
export class LlmAttemptDeadlineError extends Error {
  /** Wall-clock bound that was exceeded, in ms — the fact worth reading in a post-mortem. */
  readonly deadlineMs: number;

  constructor(deadlineMs: number, options?: { cause?: unknown }) {
    super(
      `the LLM attempt exceeded its local ${Math.round(deadlineMs / 1000)}s deadline and was aborted`,
      options,
    );
    this.name = 'LlmAttemptDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * The classification of ONE failed LLM call — the single typed value that travels from the
 * decision layer to the scheduler and to the journal. Both consumers read THIS; neither
 * re-derives anything from text.
 */
export interface LlmFailureClassification {
  /** `null` = not a known-transient transport fault → the generic backoff applies. */
  failureClass: LlmFailureClass | null;
  /** The error's own class name (`RateLimitError`, `APIConnectionError`, …) — diagnosis only. */
  errorType: string;
  /** The error message, cleaned and bounded. Diagnosis only — never read to classify. */
  message: string;
  /** HTTP status when the failure had a response (429, 500, 529…); null for transport/deadline. */
  httpStatus: number | null;
  /** Anthropic's request id when the error carried one — the only handle into their side. */
  requestId: string | null;
  /**
   * The attempt AS THE APPLICATION COUNTS IT: 1 = the first call, 2 = the coherence guard's
   * single relaunch. NOT the number of HTTP requests — see `sdkRequestCount`.
   */
  logicalAttempt: number | null;
  /**
   * How many HTTP requests the SDK really made inside that one logical attempt.
   *
   * ALWAYS null today, and that is a deliberate, checked null. The SDK decrements a private
   * `retriesRemaining` through `makeRequest`/`retryRequest` and exposes no count on the
   * thrown error (verified against @anthropic-ai/sdk 0.100.1). `maxRetries` is a CEILING,
   * not an observation: writing `1 + maxRetries` here would journal a number nobody
   * measured, and a fabricated number is worse than an honest hole precisely because it
   * reads like evidence. The field exists so that the day the SDK does expose it, there is
   * a place to put it — and so a reader knows the hole is known.
   */
  sdkRequestCount: number | null;
  /** Wall-clock the failed attempt burned, in ms. Null when the caller did not measure it. */
  elapsedMs: number | null;
}

/** Facts about the attempt that the error itself cannot carry. */
export interface AttemptFacts {
  logicalAttempt: number | null;
  elapsedMs: number | null;
}

/**
 * Keeps a stack trace or a pathological provider body from turning one journal row into a
 * wall of text. The message is a diagnostic aid, not a payload.
 */
const MAX_MESSAGE_CHARS = 600;

/**
 * Defence in depth on the ONE secret that could plausibly reach an error message: the API
 * key. The SDK does not echo it today — an `AuthenticationError` carries the response body,
 * not the credential that was sent — but this row is written unattended, forever, on a path
 * that only runs when something already went wrong, and "does not today" is not a property
 * worth betting a leaked key on.
 */
const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** Cleaned, bounded, and stripped of anything key-shaped. Never used for classification. */
export function cleanMessage(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim().replace(API_KEY_PATTERN, 'sk-ant-[REDACTED]');
  return collapsed.length <= MAX_MESSAGE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_MESSAGE_CHARS)}… [truncated]`;
}

/** The error's class name, with a usable fallback for a bare `Error` or a thrown non-Error. */
function errorTypeOf(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== 'Error' ? err.name : err.constructor.name;
  }
  return typeof err;
}

/**
 * Is this HTTP status one the provider itself tells us to come back from?
 *
 *   - 429  : rate limited — the canonical "later, not never";
 *   - 5xx  : the provider's own fault, 529 `overloaded_error` included (seen twice on
 *            23/06/2026, and it is a 5xx like any other — no special case needed).
 *
 * 4xx OTHER THAN 429 is deliberately absent: 401/403 are credentials, 400/422 are a
 * malformed request, 404 is a wrong model id. Retrying any of those faster changes nothing
 * except how quickly the same wall is hit again.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * THE SINGLE CLASSIFICATION FUNCTION. Everything downstream — the backoff, the journal,
 * the alert — consumes its output; nothing re-derives a class of its own.
 *
 * Order matters, and it is the order of certainty:
 *   1. our own deadline, recognised by its type (the owner of the signal built it);
 *   2. an abort we did NOT cause → unclassified, because we cannot say who aborted it;
 *   3. a connection/transport failure from the SDK (DNS, refused, socket, read timeout);
 *   4. an HTTP status the provider marks as transient.
 * Anything else falls through with `failureClass: null`.
 */
export function classifyLlmFailure(err: unknown, facts: AttemptFacts): LlmFailureClassification {
  const base = {
    errorType: errorTypeOf(err),
    message: cleanMessage(err instanceof Error ? err.message : String(err)),
    httpStatus: null as number | null,
    requestId: null as string | null,
    logicalAttempt: facts.logicalAttempt,
    // See the field's own comment: the SDK exposes no such count, and inventing one from
    // `maxRetries` would journal a ceiling as if it were a measurement.
    sdkRequestCount: null as number | null,
    elapsedMs: facts.elapsedMs,
  };

  // 1. OUR deadline. The only construction site is `runDecision`, guarded by the flag its
  //    own timer sets — so reaching here means the local bound really was the cause.
  if (err instanceof LlmAttemptDeadlineError) {
    return { ...base, failureClass: 'retryable_llm_transport' };
  }

  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const requestId = typeof err.requestID === 'string' ? err.requestID : null;
    const withResponse = { ...base, httpStatus: status, requestId };

    // 2. An abort nobody here owns. `APIUserAbortError` extends `APIError` with an
    //    undefined status, so it MUST be tested before the status branches — but the
    //    reason it is tested at all is that it must NOT be retryable: if our own timer
    //    did not fire, we do not know what cancelled the request, and an unknown cause
    //    keeps the generic policy. (This is also what makes the class independent of the
    //    SDK's wording: `Request was aborted.` on its own proves nothing.)
    if (err instanceof APIUserAbortError) {
      return { ...withResponse, failureClass: null };
    }

    // 3. Transport: no response ever came back. `APIConnectionTimeoutError` extends this,
    //    so the SDK's own per-request timeout lands here too.
    if (err instanceof APIConnectionError) {
      return { ...withResponse, failureClass: 'retryable_llm_transport' };
    }

    // 4. A response came back, and the provider said "later".
    if (status != null && isRetryableStatus(status)) {
      return { ...withResponse, failureClass: 'retryable_llm_transport' };
    }

    // Auth, permission, bad request, unknown model, unprocessable — none of them get
    // faster retries. They need a human.
    return { ...withResponse, failureClass: null };
  }

  // Anything that is not an SDK error at all: a config throw, a bug, a rejected non-Error.
  // Never retryable by optimism.
  return { ...base, failureClass: null };
}

/**
 * THE SINGLE SERIALIZATION FUNCTION for the failure journal.
 *
 * Written into the existing TEXT column that already held the raw error message
 * (`decisions.raw_response` on the first-call path), so this PR needs NO migration. The
 * version tag is what makes that safe to evolve: a reader can tell a v1 failure journal
 * from whatever comes later, and — because a decision row that FAILED has never carried a
 * model response — from a nominal `raw_response`, which is the model's JSON and is only
 * ever written on a non-error status.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: the API key, the system prompt, the user prompt, the
 * full header set, and any response body. The provider's error body can echo request
 * content, and this row is written unattended and kept forever. What survives is the
 * class, the type, a cleaned message, the status, the request id, and the timings — every
 * field a post-mortem needs and nothing a leak would want.
 *
 * Unknown fields are `null`, never a plausible-looking default. `sdk_request_count` is the
 * one to watch: it is null because the SDK does not report it, not because it was zero.
 */
export function serializeLlmFailure(c: LlmFailureClassification): string {
  return JSON.stringify({
    schema_version: 1,
    failure_class: c.failureClass,
    error_type: c.errorType,
    message: c.message,
    http_status: c.httpStatus,
    request_id: c.requestId,
    logical_attempt: c.logicalAttempt,
    sdk_request_count: c.sdkRequestCount,
    elapsed_ms: c.elapsedMs,
  });
}
