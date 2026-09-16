import type { Env } from '../types';
import { getModelCatalog, type ModelRecord } from './models-catalog';
import { setCreditBalance } from './credits';

export const DIGITALOCEAN_CHAT_URL = 'https://inference.do-ai.run/v1/chat/completions';
export const DIGITALOCEAN_MODELS_URL = 'https://inference.do-ai.run/v1/models';
export const DIGITALOCEAN_BALANCE_URL = 'https://api.digitalocean.com/v2/customers/my/balance';

const MAPPING_CONFIG_KEY = 'routing:digitalocean-models';

export interface DigitalOceanModelMapping {
  match: string;
  model: string;
  /** When true, only an exact (case-insensitive) model id matches this entry. */
  exact?: boolean;
}

export const DEFAULT_DIGITALOCEAN_MODEL_MAPPING: DigitalOceanModelMapping[] = [
  { match: 'glm-5.3', model: 'glm-5.3', exact: true },
  { match: 'glm-', model: 'glm-5.3-flash' },
  { match: 'llama-', model: 'llama-4-maverick' },
  { match: 'deepseek-', model: 'deepseek-v4.1-flash' },
  { match: 'mistral-', model: 'mistral-3-14B' },
  { match: 'openai-gpt-oss', model: 'openai-gpt-oss-120b' },
  { match: 'gpt-oss-', model: 'openai-gpt-oss-120b' }
];

export interface DigitalOceanBalanceSnapshot {
  balance: number;
  syncedAt: string;
}

/**
 * Sync the DO prepaid account balance into the credit ledger. Uses a
 * `dop_v1_` team token; no-ops when the token is not configured. The balance
 * is account-level and shared with other DO products.
 */
export async function syncDigitalOceanBalance(env: Env): Promise<DigitalOceanBalanceSnapshot | null> {
  const token = env.DIGITAL_OCEAN_BALANCE_TOKEN;
  if (!token) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(DIGITALOCEAN_BALANCE_URL, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as { balance?: unknown };
  const balance = Number(payload?.balance);
  if (!Number.isFinite(balance)) {
    return null;
  }

  const syncedAt = new Date().toISOString();
  try {
    await setCreditBalance(env, 'digitalocean', balance, 'USD');
  } catch {
    // Ledger write failure must not fail the sync; next cron retries.
  }

  return { balance, syncedAt };
}

export async function getDigitalOceanModelMapping(env: Env): Promise<DigitalOceanModelMapping[]> {
  if (!env.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return DEFAULT_DIGITALOCEAN_MODEL_MAPPING;
  }

  let configured: unknown;
  try {
    configured = await env.CORTEX_CONFIG.get(MAPPING_CONFIG_KEY, { type: 'json' });
  } catch {
    return DEFAULT_DIGITALOCEAN_MODEL_MAPPING;
  }

  if (!Array.isArray(configured)) {
    return DEFAULT_DIGITALOCEAN_MODEL_MAPPING;
  }

  const mappings: DigitalOceanModelMapping[] = [];
  for (const entry of configured) {
    const candidate = entry as { match?: unknown; model?: unknown; exact?: unknown };
    if (typeof candidate?.match !== 'string' || typeof candidate?.model !== 'string') continue;
    if (candidate.match.length === 0 || candidate.model.length === 0) continue;
    mappings.push({
      match: candidate.match,
      model: candidate.model,
      exact: candidate.exact === true ? true : undefined
    });
  }

  return mappings.length > 0 ? mappings : DEFAULT_DIGITALOCEAN_MODEL_MAPPING;
}

function splitVendorPrefix(model: string): { vendor?: string; name: string } {
  const slashIndex = model.indexOf('/');
  if (slashIndex > 0 && slashIndex < model.length - 1) {
    return {
      vendor: model.slice(0, slashIndex).toLowerCase(),
      name: model.slice(slashIndex + 1)
    };
  }
  return { name: model };
}

/**
 * Resolve a client-facing model to a DigitalOcean model slug via the KV mapping
 * table (prefix match, first entry wins). Returns undefined when nothing maps —
 * unmapped models are never routed to DO.
 */
export function mapDigitalOceanModel(model: string, mappings: DigitalOceanModelMapping[]): string | undefined {
  const { name } = splitVendorPrefix(model);
  const lowered = name.toLowerCase();

  for (const entry of mappings) {
    const target = entry.match.toLowerCase();
    if (entry.exact ? lowered === target : lowered.startsWith(target)) {
      return entry.model;
    }
  }

  return undefined;
}

/**
 * Resolve the DO target for a model, gated on the current DO catalog so
 * deprecated slugs fail over instead of 404-ing. When no catalog has been
 * fetched yet (fresh deployment), the mapping is trusted to self-bootstrap;
 * the daily refresh tightens the guard afterwards.
 */
export async function resolveDigitalOceanModel(env: Env, model: string): Promise<string | undefined> {
  const mappings = await getDigitalOceanModelMapping(env);
  const mapped = mapDigitalOceanModel(model, mappings);
  if (!mapped) return undefined;

  const catalog = await getModelCatalog(env, 'digitalocean');
  if (!catalog) {
    return mapped;
  }

  const slugs = new Set(catalog.models.map((record: ModelRecord) => record.id));
  return slugs.has(mapped) ? mapped : undefined;
}

export async function fetchDigitalOceanModels(env: Env): Promise<ModelRecord[]> {
  if (!env.DIGITAL_OCEAN_MODEL_ACCESS_KEY) {
    return [];
  }

  let response: Response;
  try {
    response = await fetch(DIGITALOCEAN_MODELS_URL, {
      headers: {
        'Authorization': `Bearer ${env.DIGITAL_OCEAN_MODEL_ACCESS_KEY}`
      }
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const payload = await response.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
  const models = Array.isArray(payload?.data) ? payload.data : [];

  return models
    .filter((model): model is { id: string; owned_by?: string } => typeof model?.id === 'string')
    .map((model): ModelRecord => ({
      id: model.id,
      provider: 'digitalocean',
      name: model.id,
      modalities: { input: ['text'], output: ['text'] },
      metadata: { owned_by: model.owned_by ?? null, source: 'api' }
    }));
}
