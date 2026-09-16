import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const pricingCalls: Array<{ provider: string; model: string }> = [];

vi.mock('../../../src/services/pricing', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/services/pricing')>();
    return {
        ...actual,
        estimateCostFromUsage: vi.fn(async (params: { provider: string; model: string; promptTokens: number; completionTokens: number }) => {
            pricingCalls.push({ provider: params.provider, model: params.model });
            return (params.promptTokens + params.completionTokens) / 1_000_000;
        })
    };
});

const { default: chatApp } = await import('../../../src/routes/chat');
const { createMockKV, createMockClientConfig, createMockCircuitBreaker, createMockCreditLedger, createMockProviderConcurrency, TEST_API_KEY } = await import('../../mocks/env');

const originalFetch = globalThis.fetch;

describe('telemetry cost computation dedupe', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let env: ReturnType<typeof createTestEnv>;

    function createTestEnv() {
        return {
            CORTEX_CLIENTS: createMockKV({ [TEST_API_KEY]: createMockClientConfig() }),
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
        } as never;
    }

    beforeEach(() => {
        pricingCalls.length = 0;
        env = createTestEnv();

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
        vi.clearAllMocks();
    });

    it('computes cost once per request (credit path result reused by telemetry)', async () => {
        const app = new Hono<{ Bindings: typeof env }>();
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
                messages: [{ role: 'user', content: 'Hello' }]
            })
        }), env, executionCtx);

        expect(response.status).toBe(200);

        // The credit deduction path computes cost once; telemetry must reuse it.
        expect(pricingCalls.length).toBe(1);
        expect(pricingCalls[0]).toMatchObject({ provider: 'openai-direct' });
    });
});
