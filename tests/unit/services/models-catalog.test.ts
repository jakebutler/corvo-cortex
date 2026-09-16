import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshAllModelCatalogs } from '../../../src/services/models-catalog';
import { createMockEnv, createMockKV, TEST_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

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

    const openaiCatalog = await env.CORTEX_CONFIG.get('models:openai', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string; routing?: string } }> };
    const anthropicCatalog = await env.CORTEX_CONFIG.get('models:anthropic', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string; routing?: string } }> };
    const geminiCatalog = await env.CORTEX_CONFIG.get('models:gemini', { type: 'json' }) as { models: Array<{ id: string; metadata?: { source?: string; routing?: string } }> };

    expect(openaiCatalog.models.some(model => model.id === 'gpt-5.2')).toBe(true);
    expect(openaiCatalog.models.every(model => model.metadata?.source === 'openrouter')).toBe(true);
    expect(openaiCatalog.models.every(model => model.metadata?.routing === 'direct')).toBe(true);

    expect(anthropicCatalog.models.some(model => model.id === 'claude-sonnet-4-5')).toBe(true);
    expect(anthropicCatalog.models.every(model => model.id.includes('.'))).toBe(false);
    expect(anthropicCatalog.models.every(model => model.metadata?.routing === 'direct')).toBe(true);

    expect(geminiCatalog.models.some(model => model.id === 'google/gemini-3-pro-preview')).toBe(true);
    expect(geminiCatalog.models.every(model => model.id.includes('/'))).toBe(true);
    expect(geminiCatalog.models.every(model => model.metadata?.routing === 'openrouter-only')).toBe(true);
  });

  it('advertisements from /v1/models are routable per provider', async () => {
    const env = createMockEnv({
      CORTEX_CONFIG: createMockKV({
        'models:all': {
          updatedAt: new Date().toISOString(),
          models: [
            { id: 'gpt-5.2', provider: 'openai', name: 'gpt-5.2', metadata: { source: 'openrouter', routing: 'direct' } },
            { id: 'claude-sonnet-4-5', provider: 'anthropic', name: 'Claude Sonnet 4.5', metadata: { source: 'openrouter', routing: 'direct' } },
            { id: 'glm-5.3-flash', provider: 'z-ai', name: 'GLM-5.3-FLASH', metadata: { routing: 'direct' } },
            { id: 'MiniMax-M2.1', provider: 'minimax', name: 'MiniMax-M2.1', metadata: { routing: 'direct' } },
            { id: 'google/gemini-3-pro-preview', provider: 'gemini', name: 'Gemini 3 Pro', metadata: { source: 'openrouter', routing: 'openrouter-only' } },
            { id: 'gemini-2.5-flash-broken', provider: 'gemini', name: 'Unroutable stripped id', metadata: { source: 'openrouter', routing: 'openrouter-only' } }
          ]
        }
      })
    });

    const { default: modelsApp } = await import('../../../src/routes/models');
    const { Hono } = await import('hono');
    const app = new Hono<{ Bindings: Env }>();
    app.route('/v1/models', modelsApp);

    const response = await app.fetch(new Request('http://localhost/v1/models', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    }), env as unknown as Env);

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Array<{ id: string }> };
    const ids = json.data.map((model) => model.id);

    expect(ids).toContain('gpt-5.2');
    expect(ids).toContain('claude-sonnet-4-5');
    expect(ids).toContain('glm-5.3-flash');
    expect(ids).toContain('MiniMax-M2.1');
    expect(ids).toContain('google/gemini-3-pro-preview');
    expect(ids).not.toContain('gemini-2.5-flash-broken');
  });

  it('warns when a refresh produces zero models and reports it in the results', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = createMockEnv({
      CORTEX_CONFIG: createMockKV(),
      OPENROUTER_API_KEY: 'test-openrouter-key'
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })));

    const results = await refreshAllModelCatalogs(env, ['anthropic']);

    expect(results.anthropic.ok).toBe(false);
    expect(results.anthropic.error).toBe('Refresh produced 0 models');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('produced 0 models'));
    warnSpy.mockRestore();
  });

  it('falls back to honest z-ai ids when scraping fails', async () => {
    const env = createMockEnv({ CORTEX_CONFIG: createMockKV() });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    await refreshAllModelCatalogs(env, ['z-ai']);

    const catalog = await env.CORTEX_CONFIG.get('models:z-ai', { type: 'json' }) as { models: Array<{ id: string }> };
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain('glm-5.3');
    expect(ids).toContain('glm-5.3-flash');
    expect(ids.every((id) => id.startsWith('glm-5'))).toBe(true);
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
