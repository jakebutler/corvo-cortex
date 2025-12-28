import { describe, it, expect, beforeEach } from 'vitest';
import { authMiddleware } from '../../src/middleware/auth';
import { Hono } from 'hono';

describe('authMiddleware', () => {
  let app: Hono;
  let mockEnv: any;

  beforeEach(() => {
    app = new Hono();
    mockEnv = {
      CORTEX_CLIENTS: {
        get: async (_key: string, options?: { type: string }) => {
          if (options?.type === 'json') {
            return {
              appId: 'test-app',
              name: 'Test App',
              defaultModel: 'gpt-4o',
              allowZai: true,
              fallbackStrategy: 'openrouter' as const,
              rateLimit: {
                requestsPerMinute: 100,
                tokensPerMinute: 50000
              }
            };
          }
          return null;
        }
      }
    };
  });

  it('should return 401 when Authorization header is missing', async () => {
    const handler = authMiddleware(async (c) => c.json({ success: true }));
    const response = await handler(new Request('http://localhost/'), mockEnv);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toContain('Missing API key');
  });

  it('should return 401 when API key is invalid', async () => {
    mockEnv.CORTEX_CLIENTS.get = async () => null;

    const handler = authMiddleware(async (c) => c.json({ success: true }));
    const request = new Request('http://localhost/', {
      headers: { 'Authorization': 'Bearer invalid-key' }
    });
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe('Invalid API Key');
  });

  it('should pass when API key is valid', async () => {
    const handler = authMiddleware(async (c) => c.json({ success: true }));
    const request = new Request('http://localhost/', {
      headers: { 'Authorization': 'Bearer sk-corvo-test-123' }
    });
    const response = await handler(request, mockEnv);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
  });
});
