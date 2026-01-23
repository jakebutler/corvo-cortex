import type { Env } from '../types';

const FIREWORKS_MODELS_KEY = 'models:fireworks';
const FIREWORKS_MODELS_URL = 'https://app.fireworks.ai/models?filter=LLM';
const FIREWORKS_API_URL = 'https://api.fireworks.ai/inference/v1/models';

export interface FireworksModelCatalog {
  updatedAt: string;
  models: string[];
}

export async function getFireworksModelCatalog(env: Env): Promise<FireworksModelCatalog | null> {
  if (!env.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return null;
  }
  const catalog = await env.CORTEX_CONFIG.get(FIREWORKS_MODELS_KEY, { type: 'json' }) as FireworksModelCatalog | null;
  return catalog;
}

export async function refreshFireworksModelCatalog(env: Env): Promise<FireworksModelCatalog> {
  let models = await fetchFromApi(env);
  if (!models.length) {
    models = await fetchFromHtml();
  }

  if (!models.length) {
    const existing = await getFireworksModelCatalog(env);
    if (existing) {
      return existing;
    }
  }

  const catalog: FireworksModelCatalog = {
    updatedAt: new Date().toISOString(),
    models: Array.from(new Set(models)).sort()
  };

  await env.CORTEX_CONFIG.put(FIREWORKS_MODELS_KEY, JSON.stringify(catalog), {
    expirationTtl: 60 * 60 * 24 * 30
  });

  return catalog;
}

export async function isFireworksModel(env: Env, model: string): Promise<boolean> {
  const catalog = await getFireworksModelCatalog(env);
  if (!catalog) return false;
  return catalog.models.includes(model);
}

async function fetchFromApi(env: Env): Promise<string[]> {
  try {
    const response = await fetch(FIREWORKS_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.FIREWORKS_API_KEY}`
      }
    });
    if (!response.ok) return [];

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return [];

    const data = await response.json() as Record<string, unknown>;
    const items = Array.isArray(data) ? data : (data.data as unknown[] | undefined);
    if (!items) return [];

    const models: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = (item as { id?: string; model?: string }).id || (item as { model?: string }).model;
      if (typeof id === 'string') {
        models.push(id);
      }
    }

    return models;
  } catch {
    return [];
  }
}

async function fetchFromHtml(): Promise<string[]> {
  try {
    const response = await fetch(FIREWORKS_MODELS_URL, { method: 'GET' });
    if (!response.ok) return [];
    const html = await response.text();

    const matches = html.matchAll(/\/models\/fireworks\/([a-zA-Z0-9._-]+)/g);
    const models: string[] = [];

    for (const match of matches) {
      if (match[1]) {
        models.push(`accounts/fireworks/models/${match[1]}`);
      }
    }

    return models;
  } catch {
    return [];
  }
}
