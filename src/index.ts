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

// CORS middleware
app.use('*', cors());

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
