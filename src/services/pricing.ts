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
