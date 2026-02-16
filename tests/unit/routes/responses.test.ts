import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import responsesApp from '../../../src/routes/responses';
import { createMockEnv, TEST_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

const originalFetch = globalThis.fetch;

describe('Responses Route - /v1/responses', () => {
    let mockEnv: Env;

    const mockExecutionCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn()
    } as unknown as ExecutionContext;

    beforeEach(() => {
        mockEnv = createMockEnv();

        globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('api.fireworks.ai')) {
                return new Response(JSON.stringify({
                    id: 'resp_test_123',
                    object: 'response',
                    model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from Fireworks' }] }],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                        total_tokens: 14
                    }
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (url.includes('langfuse.com')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not found', { status: 404 });
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('does not include rate limit headers on successful responses', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello'
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(200);
        expect(response.headers.get('RateLimit-Limit')).toBeNull();
        expect(response.headers.get('RateLimit-Remaining')).toBeNull();
        expect(response.headers.get('RateLimit-Reset')).toBeNull();
        expect(response.headers.get('RateLimit-Used')).toBeNull();
    });
});
