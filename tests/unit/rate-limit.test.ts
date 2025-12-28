import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimitCheckMiddleware } from '../../src/middleware/rate-limit';
import { Hono } from 'hono';

describe('rateLimitCheckMiddleware', () => {
  let app: Hono;
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      CORTEX_CLIENTS: {
        get: async (_key: string, options?: { type: string }) => {
          if (options?.type === 'json') {
            // Return a client config for key validation
            return {
              appId: 'test-app',
              name: 'Test App',
              defaultModel: 'gpt-4o',
              allowZai: true,
              fallbackStrategy: 'openrouter' as const,
              rateLimit: {
                requestsPerMinute: 10,
                tokensPerMinute: 1000
              }
            };
          }
          // Return current usage (empty)
          return null;
        }
      }
    };
  });

  it('should pass when rate limit not exceeded', async () => {
    const middleware = rateLimitCheckMiddleware;
    const nextCalled = { value: false };

    const context = {
      get: (key: string) => {
        if (key === 'client') return mockEnv.CORTEX_CLIENTS.get('test', { type: 'json' });
        return undefined;
      },
      set: () => {},
      req: {
        header: (name: string) => name === 'Authorization' ? 'Bearer test-key' : undefined
      },
      json: (data: any, status?: number) => ({
        status: status || 200,
        json: async () => data
      })
    } as any;

    await middleware(context, async () => {
      nextCalled.value = true;
    });

    expect(nextCalled.value).toBe(true);
  });

  it('should return 429 when request limit exceeded', async () => {
    const middleware = rateLimitCheckMiddleware;

    const context = {
      get: (key: string) => {
        if (key === 'client') return {
          rateLimit: { requestsPerMinute: 10, tokensPerMinute: 1000 },
          admin: false
        };
        return { requests: 10, tokens: 0 }; // Already at limit
      },
      set: () => {},
      req: {
        header: (name: string) => name === 'Authorization' ? 'Bearer test-key' : undefined
      },
      json: (data: any, status: number) => ({
        status,
        json: async () => data
      })
    } as any;

    const result = await middleware(context, async () => {});

    expect(result.status).toBe(429);
    const json = await result.json();
    expect(json.error).toContain('Rate limit exceeded');
    expect(json.type).toBe('requests');
  });

  it('should bypass for admin keys', async () => {
    const middleware = rateLimitCheckMiddleware;
    const nextCalled = { value: false };

    const context = {
      get: (key: string) => {
        if (key === 'client') return { admin: true };
        return undefined;
      },
      set: () => {},
      req: {
        header: (name: string) => name === 'Authorization' ? 'Bearer admin-key' : undefined
      }
    } as any;

    await middleware(context, async () => {
      nextCalled.value = true;
    });

    expect(nextCalled.value).toBe(true);
  });
});
