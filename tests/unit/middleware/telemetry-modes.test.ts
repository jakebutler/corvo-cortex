import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import chatApp from '../../../src/routes/chat';
import {
    createMockKV,
    createMockClientConfig,
    createMockCircuitBreaker,
    createMockCreditLedger,
    createMockProviderConcurrency,
    TEST_API_KEY
} from '../../mocks/env';
import type { Env, TelemetryMode } from '../../../src/types';
import { resetRedactionCacheForTests } from '../../../src/services/telemetry';

const originalFetch = globalThis.fetch;

function createEnv(telemetryMode: TelemetryMode | undefined): Env {
    const clientConfig = createMockClientConfig();
    if (telemetryMode !== undefined) {
        (clientConfig as { telemetry?: TelemetryMode }).telemetry = telemetryMode;
    }
    return {
        CORTEX_CLIENTS: createMockKV({ [TEST_API_KEY]: clientConfig }),
        CORTEX_CONFIG: createMockKV(),
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        OPENAI_API_KEY: 'test-openai-key',
        ZAI_API_KEY: 'test-zai-key',
        OPENROUTER_API_KEY: 'test-openrouter-key',
        MINIMAX_API_KEY: 'test-minimax-key',
        FIREWORKS_API_KEY: 'test-fireworks-key',
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_SECRET_KEY: 'sk-lf-test',
        LANGFUSE_BASE_URL: 'https://langfuse.test',
        CIRCUIT_BREAKER: createMockCircuitBreaker(),
        CREDIT_LEDGER: createMockCreditLedger(),
        PROVIDER_CONCURRENCY: createMockProviderConcurrency(),
        ENVIRONMENT: 'test',
        CREDITS_OPENAI: 'true'
    } as Env;
}

async function sendChatRequest(env: Env): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/v1/chat/completions', chatApp);

    const request = new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${TEST_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello from telemetry test' }]
        })
    });

    const executionCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn()
    } as unknown as ExecutionContext;

    return app.fetch(request, env, executionCtx);
}

function getLangfuseIngestionCalls(fetchSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
    return fetchSpy.mock.calls
        .filter((call) => String(call[0]).includes('langfuse.test'))
        .map((call) => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>);
}

describe('telemetry data minimization', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        resetRedactionCacheForTests();
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.includes('langfuse.test')) {
                return new Response(JSON.stringify({ successes: [{ id: 'evt', status: 201 }], errors: [] }), {
                    status: 207,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (target.includes('openai.com')) {
                return new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: 'gpt-4o',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('Not found', { status: 404 });
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        globalThis.fetch = originalFetch;
    });

    it('full mode ships redacted input and output payloads', async () => {
        const env = createEnv('full');
        const response = await sendChatRequest(env);
        expect(response.status).toBe(200);

        const ingestions = getLangfuseIngestionCalls(fetchSpy);
        expect(ingestions.length).toBe(1);

        const trace = (ingestions[0].batch as Array<{ type: string; body: Record<string, unknown> }>)[0];
        expect(trace.type).toBe('trace-create');
        const input = trace.body.input as { messages: Array<{ content: string }> };
        expect(input.messages[0].content).toContain('Hello from telemetry test');
        expect(trace.body.metadata).toMatchObject({ telemetry_mode: 'full' });
    });

    it('metadata mode ships no input/output payloads but keeps metadata', async () => {
        const env = createEnv('metadata');
        const response = await sendChatRequest(env);
        expect(response.status).toBe(200);

        const ingestions = getLangfuseIngestionCalls(fetchSpy);
        expect(ingestions.length).toBe(1);

        const batch = ingestions[0].batch as Array<{ type: string; body: Record<string, unknown> }>;
        for (const event of batch) {
            expect(event.body.input).toBeUndefined();
            expect(event.body.output).toBeUndefined();
        }
        expect(batch[0].body.metadata).toMatchObject({ telemetry_mode: 'metadata', provider: 'openai-direct' });
    });

    it('off mode sends nothing to Langfuse', async () => {
        const env = createEnv('off');
        const response = await sendChatRequest(env);
        expect(response.status).toBe(200);

        expect(getLangfuseIngestionCalls(fetchSpy).length).toBe(0);
    });

    it('redacts secret-looking strings from payloads before ingestion', async () => {
        const env = createEnv('full');
        const app = new Hono<{ Bindings: Env }>();
        app.route('/v1/chat/completions', chatApp);

        const executionCtx = {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn()
        } as unknown as ExecutionContext;

        const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'my key is sk-abcdef1234567890 keep it safe' }]
            })
        }), env, executionCtx);

        expect(response.status).toBe(200);

        const ingestions = getLangfuseIngestionCalls(fetchSpy);
        const serialized = JSON.stringify(ingestions);
        expect(serialized).not.toContain('sk-abcdef1234567890');
        expect(serialized).toContain('[REDACTED]');
    });

    it('truncates oversized payloads with a marker', async () => {
        const env = createEnv('full');
        const app = new Hono<{ Bindings: Env }>();
        app.route('/v1/chat/completions', chatApp);

        const executionCtx = {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn()
        } as unknown as ExecutionContext;

        const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'x'.repeat(60_000) }]
            })
        }), env, executionCtx);

        expect(response.status).toBe(200);

        const ingestions = getLangfuseIngestionCalls(fetchSpy);
        const trace = (ingestions[0].batch as Array<{ type: string; body: Record<string, unknown> }>)[0];
        const input = trace.body.input as { truncated?: boolean; originalChars?: number; preview?: string };

        expect(input.truncated).toBe(true);
        expect(input.originalChars).toBeGreaterThan(50_000);
        expect(input.preview.length).toBeLessThanOrEqual(50_000);
    });
});
