import type { Env, ClientConfig, LLMProvider } from '../types';

/**
 * Provider routing configuration
 */
export interface ProviderRoute {
  provider: LLMProvider;
  url: string;
  headers: Record<string, string>;
}

/**
 * Determine which provider to route the request to based on model and configuration
 */
export function determineProvider(
  model: string,
  client: ClientConfig,
  env: Env
): ProviderRoute {
  const creditsAnthropic = env.CREDITS_ANTHROPIC === 'true';
  const creditsOpenAI = env.CREDITS_OPENAI === 'true';

  // 1. Z.ai Pro - explicit routing
  if (model.includes('glm') || model.startsWith('z-ai')) {
    return {
      provider: 'z-ai-pro',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ZAI_API_KEY}`
      }
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
      }
    };
  }

  // 3. OpenAI Direct - if credits available
  if ((model.includes('gpt') || model.startsWith('o1')) && creditsOpenAI) {
    return {
      provider: 'openai-direct',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      }
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
    }
  };
}
