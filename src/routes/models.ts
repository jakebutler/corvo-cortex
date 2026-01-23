import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware } from '../middleware/auth';
import { getMergedModelCatalog } from '../services/models-catalog';

const modelsApp = new Hono<{ Bindings: Env }>();

// Apply auth to all routes
modelsApp.use('*', authMiddleware);

/**
 * GET /v1/models
 * Returns a curated list of models recommended for Corvo apps
 */
modelsApp.get('/', async (c) => {
  const client = c.get('client');

  const catalog = await getMergedModelCatalog(c.env);
  const models = catalog?.models?.map(model => ({
    id: model.id,
    provider: model.provider,
    name: model.name || model.id
  })) || [
    { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o' }
  ];

  return c.json({
    object: 'list',
    data: models,
    defaults: {
      system_default: 'gpt-4o',
      client_default: client.defaultModel || 'gpt-4o'
    }
  });
});

export default modelsApp;
