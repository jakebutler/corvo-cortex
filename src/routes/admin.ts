import { Hono } from 'hono';
import type { Env, RateLimitUsage } from '../types';
import { adminAuthMiddleware } from '../middleware/auth';

const adminApp = new Hono<{ Bindings: Env }>();

// Apply admin auth to all routes
adminApp.use('*', adminAuthMiddleware);

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

export default adminApp;
