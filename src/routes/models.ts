import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware } from '../middleware/auth';

const modelsApp = new Hono<{ Bindings: Env }>();

// Apply auth to all routes
modelsApp.use('*', authMiddleware);

/**
 * GET /v1/models
 * Returns a curated list of models recommended for Corvo apps
 */
modelsApp.get('/', async (c) => {
  const client = c.get('client');

  // Static list of curated models (from PRD)
  const curatedModels = [
    { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o (Reasoning)' },
    { id: 'claude-3-5-sonnet', provider: 'anthropic', name: 'Claude 3.5 Sonnet (Coding)' },
    { id: 'glm-4-plus', provider: 'z-ai', name: 'GLM-4 (Creative)' },
    { id: 'gpt-4o-mini', provider: 'openai', name: 'GPT-4o Mini (Fast)' },
    { id: 'claude-3-haiku', provider: 'anthropic', name: 'Claude 3 Haiku (Economical)' },
  ];

  return c.json({
    object: 'list',
    data: curatedModels,
    defaults: {
      system_default: 'gpt-4o',
      client_default: client.defaultModel || 'gpt-4o'
    }
  });
});

export default modelsApp;
