import { Hono } from 'hono';
import type { Env } from '../types';
import { adminAuthMiddleware } from '../middleware/auth';

const analyticsApp = new Hono<{ Bindings: Env }>();

// Apply admin auth to all routes
analyticsApp.use('*', adminAuthMiddleware);

/**
 * GET /analytics/costs
 * Get cost breakdown by app/provider
 * Note: This returns summary data. Detailed data comes from LangFuse.
 */
analyticsApp.get('/costs', async (c) => {
  const { from, to, appId } = c.req.query();

  // This is a placeholder for aggregating cost data
  // In production, you'd query LangFuse API or maintain local cost tracking
  return c.json({
    message: 'Cost data is available in LangFuse dashboard',
    langfuseUrl: 'https://cloud.langfuse.com',
    params: { from, to, appId },
    note: 'Use LangFuse dashboard for detailed cost analysis per app and provider'
  });
});

/**
 * GET /analytics/metrics
 * Get usage metrics summary
 */
analyticsApp.get('/metrics', async (c) => {
  const appId = c.req.query('app');

  // Placeholder metrics - in production, aggregate from LangFuse
  return c.json({
    message: 'Metrics are available in LangFuse dashboard',
    langfuseUrl: 'https://cloud.langfuse.com',
    filters: { appId },
    availableMetrics: [
      'total_requests',
      'total_tokens',
      'total_cost',
      'avg_latency',
      'error_rate',
      'provider_distribution'
    ]
  });
});

/**
 * GET /analytics/export
 * Export data in JSON format for external analysis
 */
analyticsApp.get('/export', async (c) => {
  const { format = 'json', appId, from, to } = c.req.query();

  // Return link to LangFuse export
  return c.json({
    exportUrl: 'https://cloud.langfuse.com',
    instructions: 'Use LangFuse dashboard to export data in CSV or JSON format',
    params: { format, appId, from, to }
  });
});

export default analyticsApp;
