import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config/index.js';
import { buildDecisionSchema, type DecisionOutput } from './schema.js';

// Memoized client (the SDK reads ANTHROPIC_API_KEY from the environment).
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY — set it in .env to run the decision layer. ' +
        'This is the brain of the bot; without it there is no decision to make.',
    );
  }
  client = new Anthropic();
  return client;
}

/** Model in effect this run: ANTHROPIC_MODEL if set, else the config default (Haiku). */
export function resolveModel(): string {
  const fromEnv = process.env.ANTHROPIC_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : config.decision.defaultModel;
}

export interface LlmResult {
  /** Schema-valid decision, or null if the model returned nothing usable. */
  parsed: DecisionOutput | null;
  /** Raw model text before parsing — always captured, for debugging parse failures. */
  rawResponse: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

export async function runDecision(params: {
  systemPrompt: string;
  userPrompt: string;
  assets: string[];
}): Promise<LlmResult> {
  const anthropic = getClient();
  const model = resolveModel();
  const schema = buildDecisionSchema(params.assets);

  const start = Date.now();
  const message = await anthropic.messages.parse({
    model,
    max_tokens: config.decision.maxTokens,
    // Frozen mandate, cache_control'd so it can be reused across runs (the
    // volatile context lives in the user turn, after this cached prefix).
    system: [
      { type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: params.userPrompt }],
    // Structured output: forces the response to match the schema (fixed
    // allocation keys → the model can't allocate to a non-tradable asset).
    output_config: { format: zodOutputFormat(schema) },
  });
  const latencyMs = Date.now() - start;

  const rawResponse = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();

  return {
    parsed: (message.parsed_output as DecisionOutput | null) ?? null,
    rawResponse,
    model: message.model ?? model,
    latencyMs,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
    stopReason: message.stop_reason ?? null,
  };
}
