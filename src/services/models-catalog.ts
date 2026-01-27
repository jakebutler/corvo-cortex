import type { Env } from '../types';
import { getFireworksModelCatalog, refreshFireworksModelCatalog } from './fireworks-models';

export type ModelProvider = 'openai' | 'anthropic' | 'z-ai' | 'minimax' | 'openrouter' | 'fireworks' | 'gemini';

export interface ModelRecord {
  id: string;
  provider: ModelProvider;
  name?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  context_length?: number;
  metadata?: Record<string, unknown>;
}

export interface ModelCatalog {
  updatedAt: string;
  models: ModelRecord[];
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const GEMINI_MODELS_URL = 'https://ai.google.dev/models/gemini';
const ZAI_CHAT_COMPLETION_URL = 'https://docs.z.ai/api-reference/llm/chat-completion';
const MINIMAX_OVERVIEW_URL = 'https://platform.minimax.io/docs/api-reference/api-overview';

const MODEL_KEYS: Record<ModelProvider, string> = {
  'openai': 'models:openai',
  'anthropic': 'models:anthropic',
  'z-ai': 'models:z-ai',
  'minimax': 'models:minimax',
  'openrouter': 'models:openrouter',
  'fireworks': 'models:fireworks:catalog',
  'gemini': 'models:gemini'
};

const ALL_MODELS_KEY = 'models:all';

export async function refreshAllModelCatalogs(
  env: Env,
  providers: ModelProvider[] = ['openai', 'anthropic', 'z-ai', 'minimax', 'openrouter', 'fireworks', 'gemini']
): Promise<Record<ModelProvider, { ok: boolean; count: number; error?: string }>> {
  const results = {} as Record<ModelProvider, { ok: boolean; count: number; error?: string }>;
  const catalogs: ModelCatalog[] = [];
  const openrouterRaw = providers.includes('openrouter') || providers.includes('openai') || providers.includes('anthropic') || providers.includes('gemini')
    ? await fetchOpenRouterRaw(env)
    : null;

  for (const provider of providers) {
    try {
      const catalog = await refreshProviderCatalog(env, provider, openrouterRaw);
      if (catalog) {
        catalogs.push(catalog);
        results[provider] = { ok: true, count: catalog.models.length };
      } else {
        results[provider] = { ok: false, count: 0, error: 'No catalog data' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      results[provider] = { ok: false, count: 0, error: message };
      const existing = await getModelCatalog(env, provider);
      if (existing) {
        catalogs.push(existing);
      }
    }
  }

  const merged = mergeCatalogs(catalogs);
  if (env.CORTEX_CONFIG && typeof env.CORTEX_CONFIG.put === 'function') {
    await env.CORTEX_CONFIG.put(ALL_MODELS_KEY, JSON.stringify(merged), {
      expirationTtl: 60 * 60 * 24 * 30
    });
  }

  return results;
}

export async function getMergedModelCatalog(env: Env): Promise<ModelCatalog | null> {
  if (!env.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return null;
  }
  const catalog = await env.CORTEX_CONFIG.get(ALL_MODELS_KEY, { type: 'json' }) as ModelCatalog | null;
  return catalog;
}

export async function getModelCatalog(env: Env, provider: ModelProvider): Promise<ModelCatalog | null> {
  if (!env.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return null;
  }
  const key = MODEL_KEYS[provider];
  const catalog = await env.CORTEX_CONFIG.get(key, { type: 'json' }) as ModelCatalog | null;
  return catalog;
}

async function refreshProviderCatalog(env: Env, provider: ModelProvider, openrouterRaw: OpenRouterRawModel[] | null): Promise<ModelCatalog | null> {
  let models: ModelRecord[] = [];

  switch (provider) {
    case 'openai':
      models = await fetchOpenAIModels(env, openrouterRaw);
      break;
    case 'anthropic':
      models = await fetchAnthropicModels(env, openrouterRaw);
      break;
    case 'z-ai':
      models = await fetchZaiModels();
      break;
    case 'minimax':
      models = await fetchMiniMaxModels();
      break;
    case 'openrouter':
      models = await fetchOpenRouterModels(env);
      break;
    case 'fireworks':
      await refreshFireworksModelCatalog(env);
      models = await fetchFireworksModels(env);
      break;
    case 'gemini':
      models = await fetchGeminiModels(openrouterRaw);
      break;
    default:
      models = [];
  }

  const catalog: ModelCatalog = {
    updatedAt: new Date().toISOString(),
    models
  };

  if (env.CORTEX_CONFIG && typeof env.CORTEX_CONFIG.put === 'function') {
    await env.CORTEX_CONFIG.put(MODEL_KEYS[provider], JSON.stringify(catalog), {
      expirationTtl: 60 * 60 * 24 * 30
    });
  }

  return catalog;
}

function mergeCatalogs(catalogs: ModelCatalog[]): ModelCatalog {
  const merged: ModelRecord[] = [];
  for (const catalog of catalogs) {
    merged.push(...catalog.models);
  }
  return {
    updatedAt: new Date().toISOString(),
    models: merged
  };
}

async function fetchOpenAIModels(env: Env, openrouterRaw: OpenRouterRawModel[] | null): Promise<ModelRecord[]> {
  const fallback = getOpenAIFallbackModels();

  const fromOpenRouter = openrouterRaw
    ? deriveOpenRouterSubset(openrouterRaw, 'openai', {
        includeIds: (id) => /^openai\/gpt-5/i.test(id),
        limit: 12
      })
    : [];

  if (fromOpenRouter.length) return fromOpenRouter;
  if (!env.OPENAI_API_KEY) return fallback;

  const response = await fetch(OPENAI_MODELS_URL, {
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`
    }
  });

  if (!response.ok) {
    return fallback;
  }

  const data = await response.json() as { data?: Array<{ id: string; created?: number; owned_by?: string }> };
  const models = data.data || [];

  const filtered = models.filter(model => isOpenAIChatOrImage(model.id));
  if (!filtered.length) return fallback;

  return filtered.map(model => ({
    id: model.id,
    provider: 'openai',
    name: model.id,
    modalities: inferOpenAIModalities(model.id),
    metadata: {
      created: model.created,
      owned_by: model.owned_by
    }
  }));
}

function isOpenAIChatOrImage(id: string): boolean {
  const allow = /^(gpt-5|gpt-5\\.|gpt-5-)/i.test(id);
  if (!allow) return false;
  const deny = /(embedding|moderation|whisper|tts|audio|transcribe|realtime|search|assistant|vision-beta|eval|code-embedding)/i.test(id);
  return !deny;
}

function inferOpenAIModalities(id: string): { input: string[]; output: string[] } {
  return { input: ['text'], output: ['text'] };
}

function getOpenAIFallbackModels(): ModelRecord[] {
  const ids = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-chat-latest',
    'gpt-5-pro',
    'gpt-5.1',
    'gpt-5.1-chat-latest',
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'gpt-5.2-pro'
  ];

  return ids.map(id => ({
    id,
    provider: 'openai',
    name: id,
    modalities: { input: ['text'], output: ['text'] }
  }));
}

async function fetchAnthropicModels(env: Env, openrouterRaw: OpenRouterRawModel[] | null): Promise<ModelRecord[]> {
  const fromOpenRouter = openrouterRaw
    ? deriveOpenRouterSubset(openrouterRaw, 'anthropic', {
        includeIds: (id) => /^anthropic\/claude/i.test(id),
        limit: 10
      })
    : [];

  if (fromOpenRouter.length) return fromOpenRouter;
  if (!env.ANTHROPIC_API_KEY) return [];

  const response = await fetch(ANTHROPIC_MODELS_URL, {
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
  const models = data.data || [];

  return models.map(model => ({
    id: model.id,
    provider: 'anthropic',
    name: model.display_name || model.id,
    modalities: { input: ['text'], output: ['text'] },
    metadata: {
      created_at: model.created_at
    }
  }));
}

async function fetchOpenRouterModels(env: Env): Promise<ModelRecord[]> {
  const models = await fetchOpenRouterRaw(env);
  return models
    .map(model => ({
      id: model.id,
      provider: 'openrouter',
      name: model.name || model.id,
      modalities: {
        input: model.architecture?.input_modalities || inferModalities(model.architecture?.modality, 'input'),
        output: model.architecture?.output_modalities || inferModalities(model.architecture?.modality, 'output')
      },
      context_length: model.context_length,
      metadata: {
        created: model.created
      }
    }))
    .filter(model => isChatOrImageModalities(model.modalities));
}

interface OpenRouterRawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
}

async function fetchOpenRouterRaw(env: Env): Promise<OpenRouterRawModel[]> {
  const headers: Record<string, string> = {};
  if (env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
  }

  const response = await fetch(OPENROUTER_MODELS_URL, { headers });
  if (!response.ok) return [];

  const data = await response.json() as { data?: OpenRouterRawModel[] };
  return data.data || [];
}

function inferModalities(modality: string | undefined, direction: 'input' | 'output'): string[] | undefined {
  if (!modality) return undefined;
  const parts = modality.split('->').map(part => part.trim());
  if (parts.length !== 2) return undefined;
  const value = direction === 'input' ? parts[0] : parts[1];
  if (!value) return undefined;
  return value.split(',').map(part => part.trim());
}

function isChatOrImageModalities(modalities?: { input?: string[]; output?: string[] }): boolean {
  if (!modalities) return false;
  const input = modalities.input || [];
  const output = modalities.output || [];
  const inputOk = input.includes('text') || input.includes('image');
  const outputOk = output.includes('text') || output.includes('image');
  return inputOk && outputOk;
}

async function fetchZaiModels(): Promise<ModelRecord[]> {
  const fallback = ['glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx'];
  const names = new Set<string>();

  try {
    const response = await fetch(ZAI_CHAT_COMPLETION_URL);
    if (response.ok) {
      const text = await response.text();
      const matches = text.matchAll(/glm-4\\.7(?:-flashx|-flash)?/gi);
      for (const match of matches) {
        names.add(match[0].toLowerCase());
      }
    }
  } catch {
    // ignore
  }

  const finalNames = names.size ? Array.from(names) : fallback;

  return finalNames
    .filter(name => name.startsWith('glm-4.7'))
    .map(name => ({
      id: name,
      provider: 'z-ai',
      name: name.toUpperCase().replace('GLM-', 'GLM-'),
      modalities: { input: ['text'], output: ['text'] }
    }));
}

async function fetchMiniMaxModels(): Promise<ModelRecord[]> {
  const fallbackText = ['MiniMax-M2.1', 'MiniMax-M2.1-lightning', 'MiniMax-M2'];
  const fallbackImage = ['image-01'];

  const textModels = new Set<string>();
  const imageModels = new Set<string>();

  try {
    const response = await fetch(MINIMAX_OVERVIEW_URL);
    if (response.ok) {
      const html = await response.text();
      const textMatches = html.matchAll(/MiniMax-M2\.1-lightning|MiniMax-M2\.1|MiniMax-M2/g);
      for (const match of textMatches) {
        textModels.add(match[0]);
      }
      const imageMatches = html.matchAll(/image-01/g);
      for (const match of imageMatches) {
        imageModels.add(match[0]);
      }
    }
  } catch {
    // ignore
  }

  const textList = textModels.size ? Array.from(textModels) : fallbackText;
  const imageList = imageModels.size ? Array.from(imageModels) : fallbackImage;

  const textRecords = textList.map(id => ({
    id,
    provider: 'minimax',
    name: id,
    modalities: { input: ['text'], output: ['text'] }
  }));

  const imageRecords = imageList.map(id => ({
    id,
    provider: 'minimax',
    name: id,
    modalities: { input: ['text', 'image'], output: ['image'] }
  }));

  return [...textRecords, ...imageRecords];
}

async function fetchFireworksModels(env: Env): Promise<ModelRecord[]> {
  const catalog = await getFireworksModelCatalog(env);
  if (!catalog) return [];
  const ids = normalizeFireworksIds(catalog.models);
  return ids.map(id => ({
    id,
    provider: 'fireworks',
    name: id,
    modalities: { input: ['text'], output: ['text'] }
  }));
}

function normalizeFireworksIds(models: unknown[]): string[] {
  const ids: string[] = [];
  for (const model of models) {
    if (typeof model === 'string') {
      ids.push(model);
      continue;
    }
    if (model && typeof model === 'object') {
      const candidate = (model as { id?: unknown }).id;
      if (typeof candidate === 'string') {
        ids.push(candidate);
        continue;
      }
      if (candidate && typeof candidate === 'object' && typeof (candidate as { id?: unknown }).id === 'string') {
        ids.push((candidate as { id: string }).id);
        continue;
      }
    }
  }
  return Array.from(new Set(ids));
}

async function fetchGeminiModels(openrouterRaw: OpenRouterRawModel[] | null): Promise<ModelRecord[]> {
  const fallback = [
    'gemini-3-pro-preview',
    'gemini-3-pro-image-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-preview-09-2025'
  ];

  const fromOpenRouter = openrouterRaw
    ? deriveOpenRouterSubset(openrouterRaw, 'gemini', {
        includeIds: (id) => /(google\/)?gemini-3|gemini-2\.5/i.test(id),
        limit: 10
      })
    : [];

  if (fromOpenRouter.length) return fromOpenRouter;

  try {
    const response = await fetch(GEMINI_MODELS_URL);
    if (!response.ok) {
      return fallback.map(id => geminiRecord(id));
    }

    const html = await response.text();
    const codes = new Set<string>();
    const matches = html.matchAll(/Model code `([^`]+)`/g);
    for (const match of matches) {
      if (match[1] && match[1].startsWith('gemini-')) {
        codes.add(match[1]);
      }
    }

    const filtered = Array.from(codes).filter(code => code.startsWith('gemini-3') || code.startsWith('gemini-2.5'));
    const finalList = filtered.length ? filtered : fallback;
    return finalList.map(id => geminiRecord(id));
  } catch {
    return fallback.map(id => geminiRecord(id));
  }
}

function geminiRecord(id: string): ModelRecord {
  const isImage = id.includes('image');
  return {
    id,
    provider: 'gemini',
    name: id,
    modalities: isImage ? { input: ['text', 'image'], output: ['image', 'text'] } : { input: ['text'], output: ['text'] }
  };
}

function deriveOpenRouterSubset(
  models: OpenRouterRawModel[],
  provider: ModelProvider,
  options: { includeIds: (id: string) => boolean; limit: number }
): ModelRecord[] {
  const scored = models
    .filter(model => options.includeIds(model.id))
    .map(model => ({
      id: model.id.includes('/') ? model.id.split('/').slice(1).join('/') : model.id,
      provider,
      name: model.name || model.id,
      modalities: {
        input: model.architecture?.input_modalities || inferModalities(model.architecture?.modality, 'input'),
        output: model.architecture?.output_modalities || inferModalities(model.architecture?.modality, 'output')
      },
      context_length: model.context_length,
      metadata: {
        created: model.created,
        source: 'openrouter'
      }
    }))
    .filter(model => isChatOrImageModalities(model.modalities));

  scored.sort((a, b) => {
    const createdA = typeof a.metadata?.created === 'number' ? (a.metadata?.created as number) : 0;
    const createdB = typeof b.metadata?.created === 'number' ? (b.metadata?.created as number) : 0;
    if (createdA !== createdB) return createdB - createdA;
    const contextA = a.context_length || 0;
    const contextB = b.context_length || 0;
    if (contextA !== contextB) return contextB - contextA;
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    const weightA = nameA.includes('pro') || nameA.includes('opus') || nameA.includes('sonnet') ? 1 : 0;
    const weightB = nameB.includes('pro') || nameB.includes('opus') || nameB.includes('sonnet') ? 1 : 0;
    return weightB - weightA;
  });

  const seen = new Set<string>();
  const result: ModelRecord[] = [];
  for (const model of scored) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
    if (result.length >= options.limit) break;
  }

  return result;
}
