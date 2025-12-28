import { Hono } from 'hono';
import type { Env } from '../types';
import { adminAuthMiddleware } from '../middleware/auth';

const healthApp = new Hono<{ Bindings: Env }>();

// Apply admin auth to all routes
healthApp.use('*', adminAuthMiddleware);

/**
 * GET /health/providers
 * Get circuit breaker status for all providers
 */
healthApp.get('/providers', async (c) => {
  if (!c.env.CIRCUIT_BREAKER) {
    return c.json({
      error: 'Circuit breaker not available'
    }, 501);
  }

  const stub = c.env.CIRCUIT_BREAKER.get(c.env.CIRCUIT_BREAKER.idFromName('status'));
  const response = await stub.fetch(
    new Request('https://circuit-breaker/status', {
      method: 'GET'
    })
  );

  if (!response.ok) {
    return c.json({
      error: 'Failed to get circuit breaker status'
    }, 500);
  }

  const data = await response.json() as { breakers: Array<unknown> };
  return c.json(data);
});

/**
 * POST /health/reset/:provider
 * Reset circuit breaker for a specific provider (admin only)
 */
healthApp.post('/reset/:provider', async (c) => {
  const provider = c.req.param('provider');

  if (!c.env.CIRCUIT_BREAKER) {
    return c.json({
      error: 'Circuit breaker not available'
    }, 501);
  }

  const stub = c.env.CIRCUIT_BREAKER.get(c.env.CIRCUIT_BREAKER.idFromName(provider));
  const response = await stub.fetch(
    new Request('https://circuit-breaker/reset', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );

  if (!response.ok) {
    return c.json({
      error: 'Failed to reset circuit breaker'
    }, 500);
  }

  const data = await response.json();
  return c.json(data);
});

export default healthApp;
