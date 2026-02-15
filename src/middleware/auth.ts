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

function getAuthCacheTtlMs(env: Env): number {
  const parsed = Number.parseInt(env.AUTH_CACHE_TTL_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTH_CACHE_TTL_MS;
  }
  return parsed;
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
  return entry.value;
}

function storeAuthCache(cacheKey: string, value: CachedClient, ttlMs: number): CachedClient {
  authCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
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
  return storeAuthCache(cacheKey, client, getAuthCacheTtlMs(env));
}

/**
 * Authentication middleware for API key validation
 *
 * Extracts Bearer token from Authorization header, validates against KV store,
 * and attaches client config to context.
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
