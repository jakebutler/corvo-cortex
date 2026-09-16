import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import modelsRoutes from './routes/models';
import chatRoutes from './routes/chat';
import healthRoutes from './routes/health';
import adminRoutes from './routes/admin';
import analyticsRoutes from './routes/analytics';
import responsesRoutes from './routes/responses';
import { CircuitBreaker } from './durable-objects/circuit-breaker';
import { CreditLedger } from './durable-objects/credit-ledger';
import { ProviderConcurrency } from './durable-objects/provider-concurrency';
import { refreshAllModelCatalogs } from './services/models-catalog';
import { syncOpenRouterCredits, clearAllProviderExhaustion } from './services/credits';
import { syncDigitalOceanBalance } from './services/digitalocean';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware - Permissive by default for API gateway use case
// Set ALLOWED_ORIGINS env var to restrict (comma-separated list)
app.use('*', cors({
  origin: (origin, c) => {
    const allowedOrigins = c.env.ALLOWED_ORIGINS;
    // If no restriction configured, allow all origins (API gateway default)
    if (!allowedOrigins || allowedOrigins === '*') {
      return origin || '*';
    }
    // Check against allowed list
    const allowed = allowedOrigins.split(',').map((o: string) => o.trim());
    return allowed.includes(origin || '') ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Authorization',
    'Content-Type',
    'X-Request-ID',
    'x-kinisi-llm-stage',
    'x-kinisi-routing-strategy',
    'x-kinisi-provider-prefer',
    'x-kinisi-provider-allow',
    'x-kinisi-provider-block',
    'x-kinisi-request-priority',
    'x-kinisi-max-latency-ms',
    'x-kinisi-request-role',
    'x-kinisi-model'
  ],
  exposeHeaders: [
    'X-Request-ID',
    'x-corvo-cortex-provider',
    'x-corvo-cortex-model',
    'x-corvo-cortex-route-id',
    'x-corvo-cortex-fallback-used',
    'x-corvo-cortex-hedge-used',
    'x-corvo-cortex-cache-hit',
    'x-corvo-cortex-ttft-ms',
    'x-corvo-cortex-latency-ms'
  ],
  maxAge: 86400,
}));

// Health check
app.get('/', (c) => {
  return c.json({ name: 'Corvo Cortex', version: '2.4.0', status: 'healthy' });
});

// Mount routes
app.route('/v1/models', modelsRoutes);
app.route('/v1/chat/completions', chatRoutes);
app.route('/v1/responses', responsesRoutes);
app.route('/health', healthRoutes);
app.route('/admin', adminRoutes);
app.route('/analytics', analyticsRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env, _ctx: unknown) {
    try {
      await refreshAllModelCatalogs(env, ['openai', 'anthropic', 'z-ai', 'minimax', 'openrouter', 'fireworks', 'gemini', 'digitalocean']);
    } catch (error) {
      console.error('Fireworks model catalog refresh failed:', error);
    }

    try {
      await syncOpenRouterCredits(env);
    } catch (error) {
      console.error('OpenRouter credit sync failed:', error);
    }

    try {
      const doSnapshot = await syncDigitalOceanBalance(env);
      if (!doSnapshot) {
        console.warn('DigitalOcean balance sync skipped (DIGITAL_OCEAN_BALANCE_TOKEN unset or API unreachable)');
      }
    } catch (error) {
      console.error('DigitalOcean balance sync failed:', error);
    }

    try {
      await clearAllProviderExhaustion(env);
    } catch (error) {
      console.error('Credit exhaustion recovery failed:', error);
    }
  }
};

// Export Durable Objects
export { CircuitBreaker };
export { CreditLedger };
export { ProviderConcurrency };
