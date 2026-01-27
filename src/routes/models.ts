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

  const providerParam = c.req.query('provider');
  const modalityParam = c.req.query('modality');

  const providers = providerParam ? providerParam.split(',').map(p => p.trim()).filter(Boolean) : [];
  const modality = modalityParam?.trim();

  const catalog = await getMergedModelCatalog(c.env);
  const catalogModels = catalog?.models || [];

  const filtered = catalogModels.filter(model => {
    const providerMatch = providers.length ? providers.includes(model.provider) : true;
    const modalityMatch = modality
      ? (model.modalities?.input?.includes(modality) || model.modalities?.output?.includes(modality))
      : true;
    return providerMatch && modalityMatch;
  });

  const sourceModels = filtered.length ? filtered : catalogModels;
  const models = sourceModels.length ? sourceModels.map(model => ({
    id: model.id,
    provider: model.provider,
    name: model.name || model.id,
    source: typeof model.metadata?.source === 'string' ? model.metadata.source : 'direct'
  })) : [
    { id: 'gpt-5.2', provider: 'openai', name: 'gpt-5.2', source: 'direct' }
  ];

  const systemDefault = models.find(model => model.id === 'gpt-5.2')?.id || models[0]?.id || 'gpt-5.2';

  return c.json({
    object: 'list',
    data: models,
    defaults: {
      system_default: systemDefault,
      client_default: client.defaultModel || systemDefault
    }
  });
});

export default modelsApp;
