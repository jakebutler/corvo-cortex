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
        expect(response.headers.get('x-corvo-cortex-provider')).toBe('fireworks');
        expect(response.headers.get('x-corvo-cortex-model')).toContain('llama');
        expect(response.headers.get('x-corvo-cortex-fallback-used')).toBe('false');
        expect(response.headers.get('RateLimit-Limit')).toBeNull();
        expect(response.headers.get('RateLimit-Remaining')).toBeNull();
        expect(response.headers.get('RateLimit-Reset')).toBeNull();
        expect(response.headers.get('RateLimit-Used')).toBeNull();
    });

    it('returns a 400 envelope for invalid JSON', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: '{not json'
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(400);
        const json = await response.json() as { error: string; details: string };
        expect(json.error).toBe('Invalid request');
        expect(json.details).toContain('valid JSON');
    });

    it('returns 400 with field details for schema-invalid payloads', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({ model: 'accounts/fireworks/models/llama-v3p1-8b-instruct' })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(400);
        const json = await response.json() as { error: string; details: Array<{ path: string[]; message: string }> };
        expect(json.error).toBe('Invalid request');
        expect(JSON.stringify(json.details)).toContain('input');
    });

    it('returns 400 when max_output_tokens exceeds the ceiling', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello',
                max_output_tokens: 40_000
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(400);
        const json = await response.json() as { error: string; details: Array<{ message: string }> };
        expect(JSON.stringify(json.details)).toContain('ceiling');
    });

    it('strips unknown fields before forwarding upstream', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello',
                smuggled_field: 'drop-me'
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(200);
        const upstreamCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
            .find((call) => String(call[0]).includes('api.fireworks.ai'));
        expect(upstreamCall).toBeDefined();
        const upstreamBody = JSON.parse(upstreamCall![1].body as string);
        expect(upstreamBody.smuggled_field).toBeUndefined();
        expect(upstreamBody.model).toContain('llama');
    });
});
