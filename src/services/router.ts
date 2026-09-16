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
  model: string;
  fallback?: {
    reason: string;
    from: LLMProvider;
  };
}

const VENDOR_PREFIX_PROVIDERS: Record<string, LLMProvider> = {
  openai: 'openai-direct',
  anthropic: 'anthropic-direct',
  'z-ai': 'z-ai-pro',
  zai: 'z-ai-pro',
  minimax: 'minimax',
  fireworks: 'fireworks'
};

interface NormalizedModel {
  vendor?: string;
  name: string;
}

function normalizeVendorPrefix(model: string): NormalizedModel {
  const slashIndex = model.indexOf('/');
  if (slashIndex > 0 && slashIndex < model.length - 1) {
    return {
      vendor: model.slice(0, slashIndex).toLowerCase(),
      name: model.slice(slashIndex + 1)
    };
  }
  return { name: model };
}

/**
 * Determine which provider to route the request to based on model and configuration.
 *
 * Matching is prefix-based on the vendor-normalized model name (never substring),
 * so crafted names like "not-claude" or "my-gpt-proxy" fall through to OpenRouter.
 * Vendor-prefixed ids ("openai/gpt-5") route to the matching direct provider with
 * the prefix stripped; unknown or mismatched vendors stay on OpenRouter, which
 * understands prefixed ids natively.
 */
export async function determineProvider(
  model: string,
  client: ClientConfig,
  env: Env
): Promise<ProviderRoute> {
  const creditsAnthropic = env.CREDITS_ANTHROPIC === 'true';
  const creditsOpenAI = env.CREDITS_OPENAI === 'true';
  let fallback: ProviderRoute['fallback'];

  const { vendor, name } = normalizeVendorPrefix(model);
  const lowered = name.toLowerCase();
  const vendorProvider = vendor === undefined
    ? undefined
    : Object.prototype.hasOwnProperty.call(VENDOR_PREFIX_PROVIDERS, vendor)
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      ? VENDOR_PREFIX_PROVIDERS[vendor]
      : null;
  const routesDirect = (provider: LLMProvider): boolean =>
    vendor === undefined || vendorProvider === provider;

  // 0. Fireworks preemption (if model in catalog and credits available)
  if (routesDirect('fireworks') && await isFireworksModel(env, name)) {
    const balance = await getCreditBalance(env, 'fireworks');
    if (!balance.configured || balance.balance > 0) {
      return {
        provider: 'fireworks',
        url: 'https://api.fireworks.ai/inference/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.FIREWORKS_API_KEY}`
        },
        model: name
      };
    }
    fallback = { reason: 'insufficient_credits', from: 'fireworks' };
  }

  // 1. Z.ai Pro - explicit routing
  if ((lowered.startsWith('glm') || lowered.startsWith('z-ai')) && routesDirect('z-ai-pro')) {
    return {
      provider: 'z-ai-pro',
      url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.ZAI_API_KEY}`
      },
      model: name,
      fallback
    };
  }

  // 2. Anthropic Direct - if credits available
  if (lowered.startsWith('claude') && creditsAnthropic && routesDirect('anthropic-direct')) {
    return {
      provider: 'anthropic-direct',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      model: name,
      fallback
    };
  }

  // 3. OpenAI Direct - if credits available
  if ((lowered.startsWith('gpt') || /^o\d/.test(lowered)) && creditsOpenAI && routesDirect('openai-direct')) {
    return {
      provider: 'openai-direct',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      },
      model: name,
      fallback
    };
  }

  // 4. MiniMax Direct - if credits available
  if (lowered.startsWith('minimax') && env.CREDITS_MINIMAX === 'true' && routesDirect('minimax')) {
    return {
      provider: 'minimax',
      url: 'https://api.minimax.io/anthropic/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.MINIMAX_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      model: name,
      fallback
    };
  }

  // 5. Fallback strategy
  if (client.fallbackStrategy === 'fail-fast') {
    throw new Error('Payment Required: Direct credits exhausted. Fail-fast policy enabled.');
  }

  // Default to OpenRouter fallback (keeps vendor-prefixed ids verbatim)
  return {
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://cortex.corvolabs.com',
      'X-Title': 'Corvo Cortex'
    },
    model,
    fallback
  };
}
