import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import modelsRoutes from './routes/models';
import chatRoutes from './routes/chat';
import healthRoutes from './routes/health';
import adminRoutes from './routes/admin';
import analyticsRoutes from './routes/analytics';
import { CircuitBreaker } from './durable-objects/circuit-breaker';

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
  allowHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
  exposeHeaders: ['X-Request-ID'],
  maxAge: 86400,
}));

// Health check
app.get('/', (c) => {
  return c.json({ name: 'Corvo Cortex', version: '2.2.0', status: 'healthy' });
});

// Mount routes
app.route('/v1/models', modelsRoutes);
app.route('/v1/chat/completions', chatRoutes);
app.route('/health', healthRoutes);
app.route('/admin', adminRoutes);
app.route('/analytics', analyticsRoutes);

export default app;

// Export Durable Objects
export { CircuitBreaker };
