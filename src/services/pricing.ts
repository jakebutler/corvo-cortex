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

  return pricing[model] || pricing.default || DEFAULT_PRICING;
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
