import type { Env, ClientConfig, LLMProvider } from '../types';
import { getCreditBalance } from './credits';
import { isFireworksModel } from './fireworks-models';

/**
 * Provider routing configuration
 */
export interface ProviderRoute {
  provider: LLMProvider;
  url: string;
  headers: Record<string, string>;
  fallback?: {
    reason: string;
    from: LLMProvider;
  };
}

/**
 * Determine which provider to route the request to based on model and configuration
 */

export async function determineProvider(
  model: string,
  client: ClientConfig,
  env: Env
): Promise<ProviderRoute> {
  const creditsAnthropic = env.CREDITS_ANTHROPIC === 'true';
  const creditsOpenAI = env.CREDITS_OPENAI === 'true';
  let fallback: ProviderRoute['fallback'];

  // 0. Fireworks preemption (if model in catalog and credits available)
  if (await isFireworksModel(env, model)) {
    const balance = await getCreditBalance(env, 'fireworks');
    if (!balance.configured || balance.balance > 0) {
      return {
        provider: 'fireworks',
        url: 'https://api.fireworks.ai/inference/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.FIREWORKS_API_KEY}`
        }
      };
    }
    fallback = { reason: 'insufficient_credits', from: 'fireworks' };
  }

  // 1. Z.ai Pro - explicit routing
  if (model.includes('glm') || model.startsWith('z-ai')) {
    return {
      provider: 'z-ai-pro',
      url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ZAI_API_KEY}`
      },
      fallback
    };
  }

  // 2. Anthropic Direct - if credits available
  if (model.includes('claude') && creditsAnthropic) {
    return {
      provider: 'anthropic-direct',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      fallback
    };
  }

  // 3. OpenAI Direct - if credits available
  if ((model.includes('gpt') || /^o\d/.test(model)) && creditsOpenAI) {
    return {
      provider: 'openai-direct',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      fallback
    };
  }

  // 4. MiniMax Direct - if credits available
  if ((model.startsWith('MiniMax') || model.startsWith('minimax')) && env.CREDITS_MINIMAX === 'true') {
    return {
      provider: 'minimax',
      url: 'https://api.minimax.io/anthropic/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.MINIMAX_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      fallback
    };
  }

  // 4. Fallback strategy
  if (client.fallbackStrategy === 'fail-fast') {
    throw new Error('Payment Required: Direct credits exhausted. Fail-fast policy enabled.');
  }

  // Default to OpenRouter fallback
  return {
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://cortex.corvolabs.com',
      'X-Title': 'Corvo Cortex'
    },
    fallback
  };
}
