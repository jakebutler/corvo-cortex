import { describe, it, expect, beforeEach } from 'vitest';
import { authMiddleware } from '../../src/middleware/auth';
import { Hono } from 'hono';
import { createMockKV, createMockClientConfig, TEST_API_KEY } from '../mocks/env';
import type { Env, Variables } from '../../src/types';
import { __clearAuthCacheForTests, __getAuthCacheSizeForTests, __getAuthCacheTtlForTests } from '../../src/middleware/auth';

describe('authMiddleware', () => {
  let app: Hono<{ Bindings: Env; Variables: Variables }>;
  let mockEnv: Env;

  beforeEach(() => {
    __clearAuthCacheForTests();

    // Create a Hono app with auth middleware and a test route
    app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', authMiddleware);
    app.get('/test', (c) => c.json({ success: true, client: c.get('client') }));

    // Set up mock environment with valid client
    mockEnv = {
      CORTEX_CLIENTS: createMockKV({
        [TEST_API_KEY]: createMockClientConfig()
      }),
      CORTEX_CONFIG: createMockKV(),
      ANTHROPIC_API_KEY: 'test',
      OPENAI_API_KEY: 'test',
      ZAI_API_KEY: 'test',
      OPENROUTER_API_KEY: 'test',
      LANGFUSE_PUBLIC_KEY: 'test',
      LANGFUSE_SECRET_KEY: 'test',
      CIRCUIT_BREAKER: {} as unknown as DurableObjectNamespace,
      ENVIRONMENT: 'test'
    } as Env;
  });

  it('should return 401 when Authorization header is missing', async () => {
    const request = new Request('http://localhost/test');
    const response = await app.fetch(request, mockEnv);

    expect(response.status).toBe(401);
    const json = await response.json() as { error: string };
    expect(json.error).toContain('Missing API key');
  });

  it('should return 401 when API key is invalid', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': 'Bearer invalid-key' }
    });
    const response = await app.fetch(request, mockEnv);

    expect(response.status).toBe(401);
    const json = await response.json() as { error: string };
    expect(json.error).toBe('Invalid API Key');
  });

  it('should pass when API key is valid', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });
    const response = await app.fetch(request, mockEnv);

    expect(response.status).toBe(200);
    const json = await response.json() as { success: boolean; client: { appId: string } };
    expect(json.success).toBe(true);
    expect(json.client.appId).toBe('test-app');
  });

  it('should reuse cached valid client lookups within TTL', async () => {
    const kvGet = async (key: string, options?: { type?: string }) => {
      if (key === TEST_API_KEY && options?.type === 'json') {
        return createMockClientConfig();
      }
      return null;
    };

    const kvGetSpy = { get: kvGet };
    const envWithSpy = {
      ...mockEnv,
      CORTEX_CLIENTS: {
        get: async (...args: Parameters<typeof kvGet>) => kvGetSpy.get(...args)
      } as unknown as KVNamespace
    } as Env;

    let getCalls = 0;
    kvGetSpy.get = async (key: string, options?: { type?: string }) => {
      getCalls += 1;
      return kvGet(key, options);
    };

    const requestA = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });
    const requestB = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });

    const responseA = await app.fetch(requestA, envWithSpy);
    const responseB = await app.fetch(requestB, envWithSpy);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(getCalls).toBe(1);
  });

  it('should not cache negative lookups', async () => {
    let getCalls = 0;
    const envWithSpy = {
      ...mockEnv,
      CORTEX_CLIENTS: {
        get: async () => {
          getCalls += 1;
          return null;
        }
      } as unknown as KVNamespace
    } as Env;

    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': 'Bearer missing-key' }
    });

    const responseA = await app.fetch(request, envWithSpy);
    const responseB = await app.fetch(request, envWithSpy);

    expect(responseA.status).toBe(401);
    expect(responseB.status).toBe(401);
    expect(getCalls).toBe(2);
    expect(__getAuthCacheSizeForTests()).toBe(0);
  });

  it('should not grow the auth cache when flooded with unique invalid keys', async () => {
    const envWithSpy = {
      ...mockEnv,
      CORTEX_CLIENTS: {
        get: async () => null
      } as unknown as KVNamespace
    } as Env;

    for (let i = 0; i < 1_500; i++) {
      const request = new Request('http://localhost/test', {
        headers: { 'Authorization': `Bearer invalid-key-${i}` }
      });
      const response = await app.fetch(request, envWithSpy);
      expect(response.status).toBe(401);
    }

    expect(__getAuthCacheSizeForTests()).toBe(0);
  });

  it('should bound the cache size when many valid keys are cached', async () => {
    const maxEntries = 1_000;
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < maxEntries + 50; i++) {
      entries[`sk-corvo-flood-${i}`] = createMockClientConfig();
    }

    const floodEnv = {
      ...mockEnv,
      CORTEX_CLIENTS: createMockKV(entries)
    } as Env;

    for (let i = 0; i < maxEntries + 50; i++) {
      const request = new Request('http://localhost/test', {
        headers: { 'Authorization': `Bearer sk-corvo-flood-${i}` }
      });
      const response = await app.fetch(request, floodEnv);
      expect(response.status).toBe(200);
    }

    expect(__getAuthCacheSizeForTests()).toBeLessThanOrEqual(maxEntries);
  });

  it('should clamp AUTH_CACHE_TTL_MS to the 5 minute maximum', () => {
    expect(__getAuthCacheTtlForTests({} as Env)).toBe(30_000);
    expect(__getAuthCacheTtlForTests({ AUTH_CACHE_TTL_MS: '45000' } as Env)).toBe(45_000);
    expect(__getAuthCacheTtlForTests({ AUTH_CACHE_TTL_MS: '999999999' } as Env)).toBe(300_000);
    expect(__getAuthCacheTtlForTests({ AUTH_CACHE_TTL_MS: 'not-a-number' } as Env)).toBe(30_000);
  });

  it('should propagate KV key deletion within the cache TTL', async () => {
    const clientsKv = createMockKV({
      [TEST_API_KEY]: createMockClientConfig()
    });
    const shortTtlEnv = {
      ...mockEnv,
      AUTH_CACHE_TTL_MS: '50',
      CORTEX_CLIENTS: clientsKv
    } as Env;

    const request = () => new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });

    const first = await app.fetch(request(), shortTtlEnv);
    expect(first.status).toBe(200);

    await clientsKv.delete(TEST_API_KEY);

    const second = await app.fetch(request(), shortTtlEnv);
    expect(second.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const third = await app.fetch(request(), shortTtlEnv);
    expect(third.status).toBe(401);
  });
});
