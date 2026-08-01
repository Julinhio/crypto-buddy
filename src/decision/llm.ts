import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config, type StrategyVersion } from '../config/index.js';
import { buildDecisionSchema, type DecisionOutput } from './schema.js';

// Memoized client.
let client: Anthropic | null = null;

/**
 * Transport retries the SDK performs inside ONE logical attempt (429s, 5xx, dropped
 * connections). Kept at 1: a hung socket is worth abandoning and redialling once.
 */
const LLM_MAX_RETRIES = 1;

/**
 * The per-REQUEST timeout: how long ONE HTTP request may take before the SDK gives up on
 * it and (once) redials. At today's values, 90s / 2 = 45s. Measured worst case ever
 * observed is 39.23s, p95 29.21s — so this cut only bites on a call that has already
 * gone far outside its distribution, and when it does the SDK redials rather than the
 * cycle dying on a wedged socket.
 *
 * It is NOT the attempt bound. See ATTEMPT_DEADLINE_MS below.
 */
const LLM_TIMEOUT_MS = Math.floor(
  (config.decision.attemptTimeoutSeconds * 1000) / (1 + LLM_MAX_RETRIES),
);

/**
 * THE ATTEMPT-WIDE DEADLINE — the bound the rest of the system actually reasons about.
 *
 * `timeout × (1 + maxRetries)` is NOT a wall-clock bound, and treating it as one is a
 * quiet lie: between a failed request and its retry the SDK SLEEPS (exponential backoff
 * with jitter, and on a 429 it honours `retry-after`, which the server can set to
 * anything). That sleep is unbudgeted, so one logical attempt can outrun the arithmetic.
 *
 * It matters because two things are asserted on that arithmetic: the startup invariant
 * `2 × attemptTimeoutSeconds + retryReserveSeconds ≤ maxCycleSeconds`, and the guard's
 * pre-retry admission check. If an attempt can overrun, a retry admitted with 135s left
 * could eat into the 45s reserved for journaling, placing orders and writing the
 * lifecycle — and the watchdog would fire DURING a booking. That is the one place this
 * codebase refuses to be sloppy.
 *
 * So the deadline is enforced with an `AbortSignal`, which the SDK honours across the
 * whole operation including its backoff sleeps — and which genuinely cancels the request
 * rather than leaving an orphan in flight, as a `Promise.race` against a timer would.
 */
const ATTEMPT_DEADLINE_MS = config.decision.attemptTimeoutSeconds * 1000;

const MISSING_KEY_MESSAGE =
  'Missing ANTHROPIC_API_KEY — set it in .env to run the decision layer. ' +
  'This is a configuration error to fix before running (the LLM is the brain of the bot).';

/**
 * A missing OR blank API key is a CONFIGURATION error, not a journaled outcome —
 * the LLM is the whole point of this layer. A whitespace-only value is a typo,
 * not a key, so it's treated as absent and fails fast (non-zero exit) up front
 * rather than reaching the API and becoming an `error` row.
 */
export function assertAnthropicConfigured(): void {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(MISSING_KEY_MESSAGE);
  }
}

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error(MISSING_KEY_MESSAGE);
  // Pass the trimmed key explicitly so accidental surrounding whitespace in
  // .env doesn't slip through to the API as a malformed credential.
  client = new Anthropic({ apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
  return client;
}

/** Model in effect this run: ANTHROPIC_MODEL if set, else the config default (Haiku). */
export function resolveModel(): string {
  const fromEnv = process.env.ANTHROPIC_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : config.decision.defaultModel;
}

export interface LlmResult {
  /** Schema-valid decision, or null if the response couldn't be parsed/validated. */
  parsed: DecisionOutput | null;
  /** Why parsing failed (null on success) — for a clear, visible log. */
  parseError: string | null;
  /** Raw model text — ALWAYS captured, including on the failure path. */
  rawResponse: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

/**
 * Calls Claude with the decision schema enforced as a structured output, then
 * parses the response ourselves.
 *
 * Error separation, by design:
 *   - API failure (down, rate-limited, auth) → `messages.create` THROWS; the
 *     caller catches it and records status='error'. We never reach the parse.
 *   - Invalid output (not JSON, or fails the schema) → `safeParse` does NOT
 *     throw; we return parsed=null + parseError, and rawResponse is always set.
 *
 * Structured outputs (output_config.format + zodOutputFormat) constrain the
 * response at the API boundary — the allocation keys are fixed, so the model
 * cannot emit a non-tradable asset. We keep `messages.create` (not
 * `messages.parse`) only so the raw text is in hand on the failure path too.
 */
export async function runDecision(params: {
  systemPrompt: string;
  userPrompt: string;
  assets: string[];
  /** Which output contract to enforce — the two strategies do not share a shape. */
  strategy?: StrategyVersion;
  /**
   * The coherence guard's SINGLE retry. Replays the rejected exchange so the model can
   * see what it actually wrote before being told what disagreed with what — sending the
   * correction ask alone would have it re-derive a decision it has already made, from a
   * context that no longer contains it.
   *
   * The rejected response goes in as a mid-conversation assistant turn, never as a
   * trailing one: a trailing assistant turn is a prefill and is rejected outright by the
   * models this bot runs on.
   */
  retry?: { rejectedResponse: string; instruction: string };
}): Promise<LlmResult> {
  const anthropic = getClient();
  const model = resolveModel();
  const schema = buildDecisionSchema(params.assets, params.strategy ?? 'v4');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: params.userPrompt }];
  if (params.retry) {
    messages.push({ role: 'assistant', content: params.retry.rejectedResponse });
    messages.push({ role: 'user', content: params.retry.instruction });
  }

  const start = Date.now();
  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: config.decision.maxTokens,
      // Frozen mandate, cache_control'd for reuse across runs (volatile context
      // lives in the user turn, after this cached prefix). The retry keeps the same
      // system prefix AND the same first user turn, so it reads the cache the first
      // attempt just wrote rather than paying for the context twice.
      system: [
        { type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages,
      output_config: { format: zodOutputFormat(schema) },
    },
    // The per-attempt bound, restated at the call site so it applies to the retry too,
    // and so the relation to the cycle budget is visible where the network call actually
    // happens. `signal` is the load-bearing one: `timeout` and `maxRetries` bound the
    // REQUESTS, the signal bounds the whole attempt including the SDK's backoff sleeps.
    { timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES, signal: AbortSignal.timeout(ATTEMPT_DEADLINE_MS) },
  );
  const latencyMs = Date.now() - start;

  const rawResponse = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();

  let parsed: DecisionOutput | null = null;
  let parseError: string | null = null;
  try {
    const json: unknown = JSON.parse(rawResponse);
    const result = schema.safeParse(json);
    if (result.success) {
      parsed = result.data as DecisionOutput;
    } else {
      parseError = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    }
  } catch (err) {
    parseError = `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    parsed,
    parseError,
    rawResponse,
    model: message.model ?? model,
    latencyMs,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
    stopReason: message.stop_reason ?? null,
  };
}
