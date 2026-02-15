import { describe, it, expect, beforeEach } from 'vitest';
import { authMiddleware } from '../../src/middleware/auth';
import { Hono } from 'hono';
import { createMockKV, createMockClientConfig, TEST_API_KEY } from '../mocks/env';
import type { Env, Variables } from '../../src/types';
import { __clearAuthCacheForTests } from '../../src/middleware/auth';

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

  it('should cache invalid lookups briefly to reduce repeated misses', async () => {
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
    expect(getCalls).toBe(1);
  });
});
