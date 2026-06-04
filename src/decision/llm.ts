import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config/index.js';
import { buildDecisionSchema, type DecisionOutput } from './schema.js';

// Memoized client.
let client: Anthropic | null = null;

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
  client = new Anthropic({ apiKey });
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
}): Promise<LlmResult> {
  const anthropic = getClient();
  const model = resolveModel();
  const schema = buildDecisionSchema(params.assets);

  const start = Date.now();
  const message = await anthropic.messages.create({
    model,
    max_tokens: config.decision.maxTokens,
    // Frozen mandate, cache_control'd for reuse across runs (volatile context
    // lives in the user turn, after this cached prefix).
    system: [
      { type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: params.userPrompt }],
    output_config: { format: zodOutputFormat(schema) },
  });
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
