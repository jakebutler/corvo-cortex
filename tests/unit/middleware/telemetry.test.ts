import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  telemetryMiddleware,
  updateTelemetryMetadata,
  storeResponseData,
  storeTelemetryUsage,
  setTelemetryCompletion
} from '../../../src/middleware/telemetry';
import type { Env } from '../../../src/types';

const mockTelemetryService = {
  createTrace: vi.fn().mockResolvedValue(undefined)
};

vi.mock('../../../src/services/telemetry', () => ({
  createTelemetryService: vi.fn(() => mockTelemetryService)
}));

describe('Telemetry Middleware', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockEnv: Env;
  let mockExecutionCtx: ExecutionContext;

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();

    mockEnv = {
      LANGFUSE_PUBLIC_KEY: 'test',
      LANGFUSE_SECRET_KEY: 'test',
      ENVIRONMENT: 'test'
    } as Env;

    mockExecutionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => promise),
      passThroughOnException: vi.fn()
    } as unknown as ExecutionContext;

    vi.clearAllMocks();
  });

  it('tracks successful requests', async () => {
    app.use('*', async (c, next) => {
      c.set('client', { appId: 'test-app' } as never);
      await next();
    });

    app.use('*', telemetryMiddleware);

    app.post('/test', async (c) => {
      updateTelemetryMetadata(c, 'openai-direct', 'gpt-4o', { prompt: 'hello' });
      storeTelemetryUsage(c, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      storeResponseData(c, { ok: true });
      return c.json({ ok: true });
    });

    const response = await app.fetch(new Request('http://localhost/test', { method: 'POST' }), mockEnv, mockExecutionCtx);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockExecutionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(mockTelemetryService.createTrace).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'test-app',
      provider: 'openai-direct',
      model: 'gpt-4o',
      statusCode: 200,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    }));
  });

  it('tracks failed requests', async () => {
    app.use('*', async (c, next) => {
      c.set('client', { appId: 'test-app' } as never);
      await next();
    });

    app.use('*', telemetryMiddleware);

    app.post('/fail', async (c) => {
      updateTelemetryMetadata(c, 'openai-direct', 'gpt-4o', { prompt: 'hello' });
      storeResponseData(c, { error: 'bad request' });
      return c.json({ error: 'bad request' }, 400);
    });

    const response = await app.fetch(new Request('http://localhost/fail', { method: 'POST' }), mockEnv, mockExecutionCtx);
    expect(response.status).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockExecutionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(mockTelemetryService.createTrace).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      error: 'bad request'
    }));
  });

  it('waits for stream completion promise before tracing', async () => {
    let resolveCompletion: (() => void) | undefined;

    app.use('*', async (c, next) => {
      c.set('client', { appId: 'test-app' } as never);
      await next();
    });

    app.use('*', telemetryMiddleware);

    app.post('/stream', async (c) => {
      updateTelemetryMetadata(c, 'openai-direct', 'gpt-4o', { prompt: 'hello' });

      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      setTelemetryCompletion(c, completion);

      return c.json({ stream: true });
    });

    const response = await app.fetch(new Request('http://localhost/stream', { method: 'POST' }), mockEnv, mockExecutionCtx);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockTelemetryService.createTrace).not.toHaveBeenCalled();

    resolveCompletion?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockTelemetryService.createTrace).toHaveBeenCalledTimes(1);
  });
});
