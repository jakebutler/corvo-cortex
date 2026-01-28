import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshAllModelCatalogs } from '../../../src/services/models-catalog';
import { createMockEnv, createMockKV } from '../../mocks/env';

vi.mock('../../../src/services/fireworks-models', () => ({
  getFireworksModelCatalog: vi.fn(async () => ({ updatedAt: new Date().toISOString(), models: [] })),
  refreshFireworksModelCatalog: vi.fn(async () => ({ updatedAt: new Date().toISOString(), models: [] }))
}));

describe('models-catalog refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives OpenAI/Anthropic/Gemini subsets from OpenRouter models', async () => {
    const env = createMockEnv({
      CORTEX_CONFIG: createMockKV(),
      OPENROUTER_API_KEY: 'test-openrouter-key'
    });

    const openrouterModels = [
      {
        id: 'openai/gpt-5.2',
        name: 'OpenAI: GPT-5.2',
        created: 10,
        context_length: 200000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      },
      {
        id: 'openai/gpt-5.2-pro',
        name: 'OpenAI: GPT-5.2 Pro',
        created: 12,
        context_length: 200000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      },
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Anthropic: Claude Sonnet 4.5',
        created: 20,
        context_length: 200000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      },
      {
        id: 'google/gemini-3-pro-preview',
        name: 'Google: Gemini 3 Pro Preview',
        created: 30,
        context_length: 100000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }
      }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      if (typeof input === 'string' && input.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: openrouterModels }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('not found', { status: 404 });
    }));

    await refreshAllModelCatalogs(env, ['openai', 'anthropic', 'gemini', 'openrouter']);

    const openaiCatalog = await env.CORTEX_CONFIG.get('models:openai', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string } }> };
    const anthropicCatalog = await env.CORTEX_CONFIG.get('models:anthropic', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string } }> };
    const geminiCatalog = await env.CORTEX_CONFIG.get('models:gemini', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string } }> };

    expect(openaiCatalog.models.some(model => model.id === 'gpt-5.2')).toBe(true);
    expect(openaiCatalog.models.every(model => model.metadata?.source === 'openrouter')).toBe(true);
    expect(anthropicCatalog.models.some(model => model.id === 'claude-sonnet-4.5')).toBe(true);
    expect(anthropicCatalog.models.every(model => model.metadata?.source === 'openrouter')).toBe(true);
    expect(geminiCatalog.models.some(model => model.id === 'gemini-3-pro-preview')).toBe(true);
    expect(geminiCatalog.models.every(model => model.metadata?.source === 'openrouter')).toBe(true);
  });

  it('normalizes fireworks catalog entries into string ids', async () => {
    const env = createMockEnv({
      CORTEX_CONFIG: createMockKV()
    });

    const fireworksModels = [
      { id: { id: 'accounts/fireworks/models/foo' } },
      { id: 'accounts/fireworks/models/bar' },
      'accounts/fireworks/models/baz'
    ];

    const { getFireworksModelCatalog, refreshFireworksModelCatalog } = await import('../../../src/services/fireworks-models');
    vi.mocked(refreshFireworksModelCatalog).mockResolvedValue({ updatedAt: new Date().toISOString(), models: fireworksModels });
    vi.mocked(getFireworksModelCatalog).mockResolvedValue({ updatedAt: new Date().toISOString(), models: fireworksModels });

    await refreshAllModelCatalogs(env, ['fireworks']);

    const catalog = await env.CORTEX_CONFIG.get('models:fireworks:catalog', { type: 'json' }) as { models: Array<{ id: string }> };
    const ids = catalog.models.map(model => model.id);
    expect(ids).toContain('accounts/fireworks/models/foo');
    expect(ids).toContain('accounts/fireworks/models/bar');
    expect(ids).toContain('accounts/fireworks/models/baz');
  });
});
