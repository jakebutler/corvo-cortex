import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { telemetryMiddleware, updateTelemetryMetadata, storeResponseData } from '../../../src/middleware/telemetry';
import type { Env } from '../../../src/types';

// Mock TelemetryService
const mockTelemetryService = {
    createTrace: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn(),
    estimateCost: vi.fn().mockReturnValue(0.01)
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
            LANGFUSE_SECRET_KEY: 'test'
        } as Env;

        mockExecutionCtx = {
            waitUntil: vi.fn((promise) => promise),
            passThroughOnException: vi.fn()
        } as unknown as ExecutionContext;

        vi.clearAllMocks();
    });

    it('should track successful requests', async () => {
        app.use('*', async (c, next) => {
            // Mock auth middleware setting client
            c.set('client', { appId: 'test-app' } as any);
            await next();
        });

        app.use('*', telemetryMiddleware);

        app.post('/test', async (c) => {
            // Simulate route handler logic
            updateTelemetryMetadata(c, 'openai', 'gpt-4o', { prompt: 'hello' });
            storeResponseData(c, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
            return c.json({ result: 'ok' });
        });

        const request = new Request('http://localhost/test', {
            method: 'POST'
        });

        const response = await app.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(200);

        // Verify waitUntil was called
        expect(mockExecutionCtx.waitUntil).toHaveBeenCalled();

        // Verify service calls (might be async inside waitUntil)
        // Since we mocked waitUntil to execute immediately or return promise, calls should have happened if we awaited fetch?
        // Actually fetch awaits the handler, but middleware calls waitUntil.
        // We might need to wait for microtasks.
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(mockTelemetryService.createTrace).toHaveBeenCalledWith(expect.objectContaining({
            appId: 'test-app',
            provider: 'openai',
            model: 'gpt-4o',
            usage: {
                promptTokens: 10,
                completionTokens: 5,
                totalTokens: 15
            }
        }));

        expect(mockTelemetryService.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'llm_request',
            appId: 'test-app',
            provider: 'openai',
            model: 'gpt-4o'
        }));
    });

    it('should ignore failed requests (>= 400)', async () => {
        app.use('*', async (c, next) => {
            c.set('client', { appId: 'test-app' } as any);
            await next();
        });

        app.use('*', telemetryMiddleware);

        app.post('/fail', async (c) => {
            updateTelemetryMetadata(c, 'openai', 'gpt-4o', {});
            return c.json({ error: 'bad' }, 400);
        });

        const request = new Request('http://localhost/fail', { method: 'POST' });
        await app.fetch(request, mockEnv, mockExecutionCtx);

        await new Promise(resolve => setTimeout(resolve, 0));

        // Should NOT track
        expect(mockExecutionCtx.waitUntil).not.toHaveBeenCalled();
        expect(mockTelemetryService.createTrace).not.toHaveBeenCalled();
    });

    it('should ignore requests without provider metadata', async () => {
        app.use('*', async (c, next) => {
            c.set('client', { appId: 'test-app' } as any);
            await next();
        });

        app.use('*', telemetryMiddleware);

        app.post('/no-meta', async (c) => {
            // Not calling updateTelemetryMetadata
            return c.json({ result: 'ok' });
        });

        const request = new Request('http://localhost/no-meta', { method: 'POST' });
        await app.fetch(request, mockEnv, mockExecutionCtx);

        expect(mockExecutionCtx.waitUntil).not.toHaveBeenCalled();
    });
});
