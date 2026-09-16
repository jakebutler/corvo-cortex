import { MiddlewareHandler } from 'hono';
import type { Env, Variables, ClientConfig } from '../types';

declare module 'hono' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ContextVariableMap extends Variables {}
}

type CachedClient = (ClientConfig & { admin?: boolean }) | null;
interface CacheEntry {
  value: CachedClient;
  expiresAt: number;
}

let authCache = new Map<string, CacheEntry>();
let namespaceIds = new WeakMap<object, string>();
let namespaceCounter = 0;
const DEFAULT_AUTH_CACHE_TTL_MS = 30_000;
const MAX_AUTH_CACHE_TTL_MS = 300_000;
const AUTH_CACHE_MAX_ENTRIES = 1_000;

function getAuthCacheTtlMs(env: Env): number {
  const parsed = Number.parseInt(env.AUTH_CACHE_TTL_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTH_CACHE_TTL_MS;
  }
  return Math.min(parsed, MAX_AUTH_CACHE_TTL_MS);
}

function getNamespaceCacheKey(env: Env, apiKey: string): string {
  const namespace = env.CORTEX_CLIENTS as unknown as object;
  let namespaceId = namespaceIds.get(namespace);
  if (!namespaceId) {
    namespaceCounter += 1;
    namespaceId = `ns-${namespaceCounter}`;
    namespaceIds.set(namespace, namespaceId);
  }

  return `${namespaceId}:${apiKey}`;
}

function fromAuthCache(cacheKey: string): CachedClient | undefined {
  const now = Date.now();
  const entry = authCache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    authCache.delete(cacheKey);
    return undefined;
  }
  authCache.delete(cacheKey);
  authCache.set(cacheKey, entry);
  return entry.value;
}

function storeAuthCache(cacheKey: string, value: CachedClient, ttlMs: number): void {
  if (value === null) return;
  authCache.delete(cacheKey);
  authCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  while (authCache.size > AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next().value;
    if (oldest === undefined) break;
    authCache.delete(oldest);
  }
}

async function getClientFromCacheOrKv(
  env: Env,
  apiKey: string
): Promise<CachedClient> {
  const cacheKey = getNamespaceCacheKey(env, apiKey);
  const cached = fromAuthCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const client = await env.CORTEX_CLIENTS.get(apiKey, { type: 'json' }) as CachedClient;
  storeAuthCache(cacheKey, client, getAuthCacheTtlMs(env));
  return client;
}

/**
 * Authentication middleware for API key validation
 *
 * Extracts Bearer token from Authorization header, validates against KV store,
 * and attaches client config to context.
 *
 * Caching semantics: only positive lookups are cached, in a bounded LRU cache
 * (max 1,000 entries) with a TTL clamped to at most 5 minutes. Negative lookups
 * are never cached, so garbage keys cannot grow the cache. Because the cache is
 * per-isolate, key revocation propagates within AUTH_CACHE_TTL_MS (default 30s,
 * max 5 min) per isolate; different PoPs may observe different views during
 * that window.
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  // 1. Extract API key from Authorization header
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey) {
    return c.json(
      { error: 'Unauthorized: Missing API key' },
      401
    );
  }

  // 2. Validate against KV store
  const clientData = await getClientFromCacheOrKv(c.env, apiKey);

  if (!clientData) {
    return c.json(
      { error: 'Invalid API Key' },
      401
    );
  }

  // 3. Attach client data to context
  c.set('client', clientData);

  await next();
};

/**
 * Admin auth middleware for elevated privileges
 * Checks for admin flag in client config
 */
export const adminAuthMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey) {
    return c.json(
      { error: 'Unauthorized: Missing API key' },
      401
    );
  }

  const clientData = await getClientFromCacheOrKv(c.env, apiKey);

  if (!clientData) {
    return c.json(
      { error: 'Invalid API Key' },
      401
    );
  }

  // Check if admin
  if (!clientData.admin) {
    return c.json(
      { error: 'Forbidden: Admin access required' },
      403
    );
  }

  c.set('client', clientData);

  await next();
};

export function __clearAuthCacheForTests(): void {
  authCache = new Map<string, CacheEntry>();
  namespaceIds = new WeakMap<object, string>();
  namespaceCounter = 0;
}

export function __getAuthCacheSizeForTests(): number {
  return authCache.size;
}

export function __getAuthCacheTtlForTests(env: Env): number {
  return getAuthCacheTtlMs(env);
}
