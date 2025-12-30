import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimitCheckMiddleware } from '../../src/middleware/rate-limit';
import { authMiddleware } from '../../src/middleware/auth';
import { Hono } from 'hono';
import { createMockKV, createMockClientConfig, TEST_API_KEY } from '../mocks/env';
import type { Env, Variables } from '../../src/types';

describe('rateLimitCheckMiddleware', () => {
  let app: Hono<{ Bindings: Env; Variables: Variables }>;

  function createTestApp(clientConfig = createMockClientConfig(), usageData: { requests: number; tokens: number } | null = null) {
    const kvData: Record<string, unknown> = {
      [TEST_API_KEY]: clientConfig
    };

    // Add rate limit usage data if provided
    if (usageData) {
      const minute = Math.floor(Date.now() / 60000);
      const rateLimitKey = `ratelimit:${TEST_API_KEY}:${minute}`;
      kvData[rateLimitKey] = usageData;
    }

    const mockEnv: Env = {
      CORTEX_CLIENTS: createMockKV(kvData),
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

    const testApp = new Hono<{ Bindings: Env; Variables: Variables }>();
    testApp.use('*', authMiddleware);
    testApp.use('*', rateLimitCheckMiddleware);
    testApp.get('/test', (c) => c.json({ success: true }));

    return { app: testApp, env: mockEnv };
  }

  it('should pass when rate limit not exceeded', async () => {
    const { app, env } = createTestApp();

    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });
    const response = await app.fetch(request, env);

    expect(response.status).toBe(200);
    const json = await response.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('should return 429 when request limit exceeded', async () => {
    // Create client with low rate limit that's already at capacity
    const clientConfig = createMockClientConfig({
      rateLimit: { requestsPerMinute: 10, tokensPerMinute: 1000 }
    });
    const { app, env } = createTestApp(clientConfig, { requests: 10, tokens: 0 });

    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });
    const response = await app.fetch(request, env);

    expect(response.status).toBe(429);
    const json = await response.json() as { error: string; type: string };
    expect(json.error).toContain('Rate limit exceeded');
    expect(json.type).toBe('requests');
  });

  it('should bypass for admin keys', async () => {
    // Admin client with admin: true
    const adminConfig = { ...createMockClientConfig(), admin: true };
    const kvData: Record<string, unknown> = { [TEST_API_KEY]: adminConfig };

    const mockEnv: Env = {
      CORTEX_CLIENTS: createMockKV(kvData),
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

    const testApp = new Hono<{ Bindings: Env; Variables: Variables }>();
    testApp.use('*', authMiddleware);
    testApp.use('*', rateLimitCheckMiddleware);
    testApp.get('/test', (c) => c.json({ success: true }));

    const request = new Request('http://localhost/test', {
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    });
    const response = await testApp.fetch(request, mockEnv);

    expect(response.status).toBe(200);
    const json = await response.json() as { success: boolean };
    expect(json.success).toBe(true);
  });
});

