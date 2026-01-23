import { Hono } from 'hono';
import type { Env, RateLimitUsage, LLMProvider } from '../types';
import { adminAuthMiddleware } from '../middleware/auth';
import { getCreditBalance, setCreditBalance, adjustCreditBalance } from '../services/credits';
import { getProviderPricing, ProviderPricing } from '../services/pricing';

const adminApp = new Hono<{ Bindings: Env }>();

// Apply admin auth to all routes
adminApp.use('*', adminAuthMiddleware);

const PROVIDERS: LLMProvider[] = ['anthropic-direct', 'openai-direct', 'z-ai-pro', 'openrouter', 'minimax', 'fireworks'];

/**
 * GET /admin/usage
 * Get current rate limit usage for all clients or a specific client
 */
adminApp.get('/usage', async (c) => {
  const apiKey = c.req.query('key');

  if (apiKey) {
    // Get usage for a specific API key
    const minute = Math.floor(Date.now() / 60000);
    const rateLimitKey = `ratelimit:${apiKey}:${minute}`;
    const usage = await c.env.CORTEX_CLIENTS.get(rateLimitKey, { type: 'json' }) as RateLimitUsage | null;

    // Also get client info
    const client = await c.env.CORTEX_CLIENTS.get(apiKey, { type: 'json' });

    return c.json({
      apiKey,
      client,
      currentMinute: new Date(minute * 1000).toISOString(),
      usage: usage || { requests: 0, tokens: 0 }
    });
  }

  // Get all API keys (list operation)
  // Note: This is a simplified approach - in production you might want a separate index
  const keys = ['sk-corvo-kinisi-xxx']; // Placeholder - would need to be populated from a list

  const usages = await Promise.all(
    keys.map(async (key) => {
      const minute = Math.floor(Date.now() / 60000);
      const rateLimitKey = `ratelimit:${key}:${minute}`;
      const usage = await c.env.CORTEX_CLIENTS.get(rateLimitKey, { type: 'json' }) as RateLimitUsage | null;
      const client = await c.env.CORTEX_CLIENTS.get(key, { type: 'json' });

      return {
        apiKey: key,
        client,
        usage: usage || { requests: 0, tokens: 0 }
      };
    })
  );

  return c.json({
    currentMinute: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(),
    clients: usages
  });
});

/**
 * GET /admin/clients
 * List all registered clients
 */
adminApp.get('/clients', async (c) => {
  // This is a placeholder - in production you'd need a way to list all keys
  // For now, return a message indicating this needs implementation
  return c.json({
    message: 'Client listing requires a separate index or database',
    note: 'Use ?key=<apiKey> query parameter to check specific client usage'
  });
});

/**
 * GET /admin/credits
 * List credit balances for all providers or a specific provider
 */
adminApp.get('/credits', async (c) => {
  const provider = c.req.query('provider') as LLMProvider | undefined;

  if (provider) {
    if (!PROVIDERS.includes(provider)) {
      return c.json({ error: 'Unknown provider' }, 400);
    }
    const balance = await getCreditBalance(c.env, provider);
    return c.json({ provider, ...balance });
  }

  const balances = await Promise.all(
    PROVIDERS.map(async (p) => ({ provider: p, ...(await getCreditBalance(c.env, p)) }))
  );

  return c.json({ providers: balances });
});

/**
 * POST /admin/credits/set
 * Set the credit balance for a provider
 */
adminApp.post('/credits/set', async (c) => {
  const body = await c.req.json() as { provider?: LLMProvider; balance?: number; currency?: 'USD' | 'credits' };
  if (!body.provider || typeof body.balance !== 'number' || !body.currency) {
    return c.json({ error: 'Invalid payload' }, 400);
  }
  if (!PROVIDERS.includes(body.provider)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const balance = await setCreditBalance(c.env, body.provider, body.balance, body.currency);
  return c.json({ provider: body.provider, ...balance });
});

/**
 * POST /admin/credits/adjust
 * Adjust the credit balance for a provider
 */
adminApp.post('/credits/adjust', async (c) => {
  const body = await c.req.json() as { provider?: LLMProvider; delta?: number; currency?: 'USD' | 'credits' };
  if (!body.provider || typeof body.delta !== 'number') {
    return c.json({ error: 'Invalid payload' }, 400);
  }
  if (!PROVIDERS.includes(body.provider)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const balance = await adjustCreditBalance(c.env, body.provider, body.delta, body.currency);
  return c.json({ provider: body.provider, ...balance });
});

/**
 * GET /admin/pricing
 * Get pricing for a provider
 */
adminApp.get('/pricing', async (c) => {
  const provider = c.req.query('provider') as LLMProvider | undefined;
  if (!provider) {
    return c.json({ error: 'Provider is required' }, 400);
  }
  if (!PROVIDERS.includes(provider)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  const pricing = await getProviderPricing(c.env, provider);
  return c.json({ provider, pricing: pricing || {} });
});

/**
 * POST /admin/pricing
 * Replace pricing for a provider
 */
adminApp.post('/pricing', async (c) => {
  const body = await c.req.json() as { provider?: LLMProvider; pricing?: ProviderPricing };
  if (!body.provider || !body.pricing || typeof body.pricing !== 'object') {
    return c.json({ error: 'Invalid payload' }, 400);
  }
  if (!PROVIDERS.includes(body.provider)) {
    return c.json({ error: 'Unknown provider' }, 400);
  }

  await c.env.CORTEX_CONFIG.put(`pricing:${body.provider}`, JSON.stringify(body.pricing));
  return c.json({ provider: body.provider, pricing: body.pricing });
});

export default adminApp;
