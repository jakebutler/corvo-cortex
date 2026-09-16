import type { Env, LLMProvider } from '../types';

export interface PricingEntry {
  input: number;
  output: number;
}

export interface ProviderPricing {
  [model: string]: PricingEntry;
}

const DEFAULT_PRICING: PricingEntry = { input: 1.0, output: 2.0 };

export async function getProviderPricing(env: Env, provider: LLMProvider): Promise<ProviderPricing | null> {
  if (!env.CORTEX_CONFIG) {
    return null;
  }
  const key = `pricing:${provider}`;
  const pricing = await env.CORTEX_CONFIG.get(key, { type: 'json' }) as ProviderPricing | null;
  return pricing;
}

export async function getModelPricing(env: Env, provider: LLMProvider, model: string): Promise<PricingEntry> {
  const pricing = await getProviderPricing(env, provider);
  if (!pricing) {
    return DEFAULT_PRICING;
  }

  const exactMatch = findModelPricing(pricing, model);
  if (exactMatch) {
    return exactMatch;
  }

  if (isPricingEntry(pricing.default)) {
    return pricing.default;
  }

  return DEFAULT_PRICING;
}

export async function estimateCostFromUsage(params: {
  env: Env;
  provider: LLMProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<number> {
  const pricing = await getModelPricing(params.env, params.provider, params.model);

  const inputCost = (params.promptTokens / 1_000_000) * pricing.input;
  const outputCost = (params.completionTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

const DEFAULT_ESTIMATED_COMPLETION_TOKENS = 4_096;
const ESTIMATED_TOKENS_PER_IMAGE = 1_000;
const CHARS_PER_TOKEN = 4;

/**
 * Upper-bound cost estimate used to size credit reservations before an
 * upstream call: estimated prompt tokens + the requested max_tokens (or a
 * conservative default when unset).
 */
export async function estimateRequestMaxCost(params: {
  env: Env;
  provider: LLMProvider;
  model: string;
  input: unknown;
  maxTokens?: number;
}): Promise<number> {
  const pricing = await getModelPricing(params.env, params.provider, params.model);
  const promptTokens = estimatePromptTokens(params.input);
  const completionTokens = params.maxTokens && params.maxTokens > 0
    ? params.maxTokens
    : DEFAULT_ESTIMATED_COMPLETION_TOKENS;

  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

export function estimatePromptTokens(input: unknown): number {
  if (typeof input === 'string') {
    return Math.ceil(input.length / CHARS_PER_TOKEN);
  }

  if (!Array.isArray(input)) {
    return 0;
  }

  let chars = 0;
  for (const message of input) {
    const content = (message as { content?: unknown })?.content;
    if (typeof content === 'string') {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === 'string') {
        chars += text.length;
        continue;
      }
      const imageUrl = (part as { image_url?: { url?: unknown } })?.image_url?.url;
      if (typeof imageUrl === 'string') {
        chars += ESTIMATED_TOKENS_PER_IMAGE * CHARS_PER_TOKEN;
      }
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function findModelPricing(pricing: ProviderPricing, model: string): PricingEntry | null {
  for (const [modelId, value] of Object.entries(pricing)) {
    if (modelId !== model) continue;
    if (isPricingEntry(value)) {
      return value;
    }
  }

  return null;
}

function isPricingEntry(value: unknown): value is PricingEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as { input?: unknown; output?: unknown };
  return typeof record.input === 'number' && typeof record.output === 'number';
}
